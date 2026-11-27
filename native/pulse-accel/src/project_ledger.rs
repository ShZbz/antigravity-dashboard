use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde::de::{self, DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::ledger_index::{
    atomic_write_cache_file, compute_known_accounts_hash, date_ymd_hour_from_tz,
    deserialize_known_accounts, is_hex64, is_ledger_file_name, list_scope_directories,
    load_accounts_meta, load_ownership, mtime_ns_from_metadata, parse_nullable_safe_int,
    parse_safe_nonneg_int, pick_primary_scope, read_cache_file_stamp, sha256_hex, write_str,
    BinCursor, KnownAccountInfo, TzTransition, MAX_RECORD_FILE_BYTES, MAX_SAFE_INT,
    PARALLEL_DIRTY_THRESHOLD,
};

const PROJECT_CACHE_FILE: &str = "project-ledger-v1.bin";
const PROJECT_CACHE_MAGIC: &[u8; 8] = b"AGPPRJ01";
const PROJECT_CACHE_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerProjectQuery {
    pub directory: String,
    pub scope: String,
    pub time_zone: String,
    #[serde(default)]
    pub fixed_offset_secs: Option<i32>,
    #[serde(default)]
    pub tz_min_ms: Option<i64>,
    #[serde(default)]
    pub tz_max_ms: Option<i64>,
    #[serde(default)]
    pub tz_transitions: Option<Vec<TzTransition>>,
    pub zero_at_date: String,
    #[serde(default)]
    pub dirty_rel_paths: Vec<String>,
}

#[derive(Debug, Clone)]
struct ProjectDayBucket {
    date: String,
    uncached: i64,
    cache_read: i64,
    cache_write: i64,
    output: i64,
    requests: i64,
    max_at: i64,
}

#[derive(Debug, Clone)]
struct CachedProjectFileEntry {
    scope: String,
    file_name: String,
    mtime_ns: i128,
    file_size: u64,
    unreadable: bool,
    doc_id: String,
    source: String,
    project_name: String,
    note: String,
    days: Vec<ProjectDayBucket>,
}

struct InMemProjectCache {
    directory: String,
    bin_mtime_ns: Option<i128>,
    bin_size: Option<u64>,
    tz_signature: [u8; 32],
    entries: Arc<HashMap<(String, String), CachedProjectFileEntry>>,
}

struct CachedSharedProjectSnapshot {
    directory: String,
    scope: String,
    tz_signature: [u8; 32],
    ownership_stamp: (Option<i128>, Option<u64>),
    accounts_stamp: (Option<i128>, Option<u64>),
    shared_files_stamp: [u8; 32],
    known_accounts_hash: [u8; 32],
    target_hashes_hash: [u8; 32],
    output_json: String,
}

#[derive(Default)]
struct ProjectMemCacheState {
    single_scope: Option<InMemProjectCache>,
    shared: Vec<CachedSharedProjectSnapshot>,
}

static PROJECT_MEM_CACHE: Mutex<ProjectMemCacheState> = Mutex::new(ProjectMemCacheState {
    single_scope: None,
    shared: Vec::new(),
});

const MAX_SHARED_SNAPSHOT_SLOTS: usize = 4;

/// Releases all cached single-scope and shared-file entries from `PROJECT_MEM_CACHE`.
pub fn release_project_mem_cache() -> bool {
    let mut guard = PROJECT_MEM_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let single_cleared = guard.single_scope.take().is_some();
    let shared_cleared = !guard.shared.is_empty();
    guard.shared.clear();
    guard.shared.shrink_to_fit();
    single_cleared || shared_cleared
}

fn compute_tz_signature_parts(
    time_zone: &str,
    fixed_offset_secs: Option<i32>,
    tz_min_ms: Option<i64>,
    tz_max_ms: Option<i64>,
    tz_transitions: Option<&[TzTransition]>,
    zero_at_date: &str,
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    let write_opt_i64 = |h: &mut Sha256, v: Option<i64>| match v {
        Some(n) => {
            h.update([1u8]);
            h.update(n.to_le_bytes());
        }
        None => h.update([0u8]),
    };
    let tz_bytes = time_zone.as_bytes();
    hasher.update((tz_bytes.len() as u32).to_le_bytes());
    hasher.update(tz_bytes);
    match fixed_offset_secs {
        Some(s) => {
            hasher.update([1u8]);
            hasher.update(s.to_le_bytes());
        }
        None => hasher.update([0u8]),
    }
    write_opt_i64(&mut hasher, tz_min_ms);
    write_opt_i64(&mut hasher, tz_max_ms);
    match tz_transitions {
        Some(list) => {
            hasher.update([1u8]);
            hasher.update((list.len() as u32).to_le_bytes());
            for t in list {
                hasher.update(t.at_ms.to_le_bytes());
                hasher.update(t.offset_secs.to_le_bytes());
            }
        }
        None => hasher.update([0u8]),
    }
    let zero_bytes = zero_at_date.as_bytes();
    hasher.update((zero_bytes.len() as u32).to_le_bytes());
    hasher.update(zero_bytes);
    hasher.finalize().into()
}

fn compute_tz_signature(query: &LedgerProjectQuery) -> [u8; 32] {
    compute_tz_signature_parts(
        &query.time_zone,
        query.fixed_offset_secs,
        query.tz_min_ms,
        query.tz_max_ms,
        query.tz_transitions.as_deref(),
        &query.zero_at_date,
    )
}

fn format_date_buf(y: i64, m: u32, d: u32) -> [u8; 10] {
    let y = y as u32;
    [
        b'0' + ((y / 1000) % 10) as u8,
        b'0' + ((y / 100) % 10) as u8,
        b'0' + ((y / 10) % 10) as u8,
        b'0' + (y % 10) as u8,
        b'-',
        b'0' + ((m / 10) % 10) as u8,
        b'0' + (m % 10) as u8,
        b'-',
        b'0' + ((d / 10) % 10) as u8,
        b'0' + (d % 10) as u8,
    ]
}

struct OptStringSeed;

impl<'de> DeserializeSeed<'de> for OptStringSeed {
    type Value = Option<String>;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Option<String>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("optional string")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(Some(v.to_string()))
            }
            fn visit_string<E: de::Error>(self, v: String) -> Result<Self::Value, E> {
                Ok(Some(v))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(None)
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
                Ok(None)
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> {
                Ok(None)
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> {
                Ok(None)
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> {
                Ok(None)
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(None)
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(None)
            }
        }
        deserializer.deserialize_any(V)
    }
}

#[derive(Default)]
struct DocMetadata {
    source: String,
    project_name: String,
    note: String,
}

enum MetaKey {
    Source,
    ProjectName,
    Note,
    Other,
}

impl<'de> Deserialize<'de> for MetaKey {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = MetaKey;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("metadata key")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(match v {
                    "source" => MetaKey::Source,
                    "projectName" => MetaKey::ProjectName,
                    "note" => MetaKey::Note,
                    _ => MetaKey::Other,
                })
            }
            fn visit_bytes<E: de::Error>(self, v: &[u8]) -> Result<Self::Value, E> {
                Ok(match v {
                    b"source" => MetaKey::Source,
                    b"projectName" => MetaKey::ProjectName,
                    b"note" => MetaKey::Note,
                    _ => MetaKey::Other,
                })
            }
        }
        deserializer.deserialize_identifier(V)
    }
}

struct MetadataSeed;

impl<'de> DeserializeSeed<'de> for MetadataSeed {
    type Value = DocMetadata;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = DocMetadata;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("metadata object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut meta = DocMetadata::default();
                while let Some(key) = map.next_key::<MetaKey>()? {
                    match key {
                        MetaKey::Source => {
                            meta.source = map.next_value_seed(OptStringSeed)?.unwrap_or_default();
                        }
                        MetaKey::ProjectName => {
                            meta.project_name =
                                map.next_value_seed(OptStringSeed)?.unwrap_or_default();
                        }
                        MetaKey::Note => {
                            meta.note = map.next_value_seed(OptStringSeed)?.unwrap_or_default();
                        }
                        MetaKey::Other => {
                            let _ = map.next_value::<IgnoredAny>()?;
                        }
                    }
                }
                Ok(meta)
            }
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(DocMetadata::default())
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
                Ok(DocMetadata::default())
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> {
                Ok(DocMetadata::default())
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> {
                Ok(DocMetadata::default())
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> {
                Ok(DocMetadata::default())
            }
            fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> {
                Ok(DocMetadata::default())
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(DocMetadata::default())
            }
        }
        deserializer.deserialize_any(V)
    }
}

struct Hex64ValidSeed;

impl<'de> DeserializeSeed<'de> for Hex64ValidSeed {
    type Value = bool;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = bool;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("64-hex string")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(is_hex64(v))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(false)
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
                Ok(false)
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> {
                Ok(false)
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> {
                Ok(false)
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> {
                Ok(false)
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(false)
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(false)
            }
        }
        deserializer.deserialize_any(V)
    }
}

struct ModelValidSeed;

impl<'de> DeserializeSeed<'de> for ModelValidSeed {
    type Value = bool;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = bool;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("model string <= 120 UTF-16 units")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(v.encode_utf16().count() <= 120)
            }
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(false)
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
                Ok(false)
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> {
                Ok(false)
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> {
                Ok(false)
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> {
                Ok(false)
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(false)
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(false)
            }
        }
        deserializer.deserialize_any(V)
    }
}

struct NullableSafeIntSeed;

impl<'de> DeserializeSeed<'de> for NullableSafeIntSeed {
    type Value = Result<Option<i64>, ()>;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Result<Option<i64>, ()>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("null or safe non-negative integer")
            }
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(Ok(None))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
                if (0..=MAX_SAFE_INT).contains(&v) {
                    Ok(Ok(Some(v)))
                } else {
                    Ok(Err(()))
                }
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
                if v <= MAX_SAFE_INT as u64 {
                    Ok(Ok(Some(v as i64)))
                } else {
                    Ok(Err(()))
                }
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
                if v.is_finite() && v >= 0.0 && v <= MAX_SAFE_INT as f64 && v.fract() == 0.0 {
                    Ok(Ok(Some(v as i64)))
                } else {
                    Ok(Err(()))
                }
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
                Ok(Err(()))
            }
            fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> {
                Ok(Err(()))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(Err(()))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(Err(()))
            }
        }
        deserializer.deserialize_any(V)
    }
}

enum RecordKey {
    Id,
    Model,
    At,
    Uncached,
    CacheRead,
    CacheWrite,
    Output,
    Other,
}

impl<'de> Deserialize<'de> for RecordKey {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = RecordKey;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("record key")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(match v {
                    "id" => RecordKey::Id,
                    "model" => RecordKey::Model,
                    "at" => RecordKey::At,
                    "uncached" => RecordKey::Uncached,
                    "cacheRead" => RecordKey::CacheRead,
                    "cacheWrite" => RecordKey::CacheWrite,
                    "output" => RecordKey::Output,
                    _ => RecordKey::Other,
                })
            }
            fn visit_bytes<E: de::Error>(self, v: &[u8]) -> Result<Self::Value, E> {
                Ok(match v {
                    b"id" => RecordKey::Id,
                    b"model" => RecordKey::Model,
                    b"at" => RecordKey::At,
                    b"uncached" => RecordKey::Uncached,
                    b"cacheRead" => RecordKey::CacheRead,
                    b"cacheWrite" => RecordKey::CacheWrite,
                    b"output" => RecordKey::Output,
                    _ => RecordKey::Other,
                })
            }
        }
        deserializer.deserialize_identifier(V)
    }
}

struct RecordItemSeed<'a> {
    query: &'a LedgerProjectQuery,
    days: &'a mut BTreeMap<String, ProjectDayBucket>,
    tz_out_of_bounds: &'a mut bool,
}

impl<'de, 'a> DeserializeSeed<'de> for RecordItemSeed<'a> {
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct V<'a> {
            query: &'a LedgerProjectQuery,
            days: &'a mut BTreeMap<String, ProjectDayBucket>,
            tz_out_of_bounds: &'a mut bool,
        }

        impl<'de, 'a> Visitor<'de> for V<'a> {
            type Value = ();
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("ledger record item")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut id_valid = false;
                let mut model_valid = false;
                let mut at_val: Option<Result<Option<i64>, ()>> = None;
                let mut uncached_val: Option<Result<Option<i64>, ()>> = None;
                let mut cache_read_val: Option<Result<Option<i64>, ()>> = None;
                let mut cache_write_val: Option<Result<Option<i64>, ()>> = None;
                let mut output_val: Option<Result<Option<i64>, ()>> = None;

                while let Some(key) = map.next_key::<RecordKey>()? {
                    match key {
                        RecordKey::Id => {
                            id_valid = map.next_value_seed(Hex64ValidSeed)?;
                        }
                        RecordKey::Model => {
                            model_valid = map.next_value_seed(ModelValidSeed)?;
                        }
                        RecordKey::At => {
                            at_val = Some(map.next_value_seed(NullableSafeIntSeed)?);
                        }
                        RecordKey::Uncached => {
                            uncached_val = Some(map.next_value_seed(NullableSafeIntSeed)?);
                        }
                        RecordKey::CacheRead => {
                            cache_read_val = Some(map.next_value_seed(NullableSafeIntSeed)?);
                        }
                        RecordKey::CacheWrite => {
                            cache_write_val = Some(map.next_value_seed(NullableSafeIntSeed)?);
                        }
                        RecordKey::Output => {
                            output_val = Some(map.next_value_seed(NullableSafeIntSeed)?);
                        }
                        RecordKey::Other => {
                            let _ = map.next_value::<IgnoredAny>()?;
                        }
                    }
                }

                if !id_valid || !model_valid {
                    return Ok(());
                }
                let (Some(Ok(at)), Some(Ok(uncached)), Some(Ok(cache_read)), Some(Ok(cache_write)), Some(Ok(output))) =
                    (at_val, uncached_val, cache_read_val, cache_write_val, output_val)
                else {
                    return Ok(());
                };

                let date_buf;
                let (date_str, rec_max_at): (&str, i64) = match at {
                    None | Some(0) => (self.query.zero_at_date.as_str(), 0),
                    Some(at_ms) => {
                        let Some((y, m, d, _hour)) = date_ymd_hour_from_tz(
                            self.query.fixed_offset_secs,
                            self.query.tz_min_ms,
                            self.query.tz_max_ms,
                            self.query.tz_transitions.as_deref(),
                            at_ms,
                        ) else {
                            *self.tz_out_of_bounds = true;
                            return Err(de::Error::custom("tz_out_of_bounds"));
                        };
                        date_buf = format_date_buf(y, m, d);
                        let s = std::str::from_utf8(&date_buf)
                            .map_err(|_| de::Error::custom("invalid date buffer"))?;
                        (s, at_ms)
                    }
                };

                let add_uncached = uncached.unwrap_or(0);
                let add_cache_read = cache_read.unwrap_or(0);
                let add_cache_write = cache_write.unwrap_or(0);
                let add_output = output.unwrap_or(0);

                if let Some(bucket) = self.days.get_mut(date_str) {
                    bucket.uncached = bucket.uncached.saturating_add(add_uncached);
                    bucket.cache_read = bucket.cache_read.saturating_add(add_cache_read);
                    bucket.cache_write = bucket.cache_write.saturating_add(add_cache_write);
                    bucket.output = bucket.output.saturating_add(add_output);
                    bucket.requests += 1;
                    if rec_max_at > bucket.max_at {
                        bucket.max_at = rec_max_at;
                    }
                } else {
                    self.days.insert(
                        date_str.to_string(),
                        ProjectDayBucket {
                            date: date_str.to_string(),
                            uncached: add_uncached,
                            cache_read: add_cache_read,
                            cache_write: add_cache_write,
                            output: add_output,
                            requests: 1,
                            max_at: rec_max_at,
                        },
                    );
                }
                Ok(())
            }

            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(())
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
                Ok(())
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> {
                Ok(())
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> {
                Ok(())
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> {
                Ok(())
            }
            fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> {
                Ok(())
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(())
            }
        }

        deserializer.deserialize_any(V {
            query: self.query,
            days: self.days,
            tz_out_of_bounds: self.tz_out_of_bounds,
        })
    }
}

struct RecordsSeed<'a> {
    query: &'a LedgerProjectQuery,
    days: &'a mut BTreeMap<String, ProjectDayBucket>,
    tz_out_of_bounds: &'a mut bool,
}

impl<'de, 'a> DeserializeSeed<'de> for RecordsSeed<'a> {
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct V<'a> {
            query: &'a LedgerProjectQuery,
            days: &'a mut BTreeMap<String, ProjectDayBucket>,
            tz_out_of_bounds: &'a mut bool,
        }

        impl<'de, 'a> Visitor<'de> for V<'a> {
            type Value = ();
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("records array")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                self.days.clear();
                while seq
                    .next_element_seed(RecordItemSeed {
                        query: self.query,
                        days: self.days,
                        tz_out_of_bounds: self.tz_out_of_bounds,
                    })?
                    .is_some()
                {}
                Ok(())
            }
        }

        deserializer.deserialize_seq(V {
            query: self.query,
            days: self.days,
            tz_out_of_bounds: self.tz_out_of_bounds,
        })
    }
}

enum DocKey {
    Id,
    Metadata,
    Records,
    Other,
}

impl<'de> Deserialize<'de> for DocKey {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = DocKey;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("ledger document key")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(match v {
                    "id" => DocKey::Id,
                    "metadata" => DocKey::Metadata,
                    "records" => DocKey::Records,
                    _ => DocKey::Other,
                })
            }
            fn visit_bytes<E: de::Error>(self, v: &[u8]) -> Result<Self::Value, E> {
                Ok(match v {
                    b"id" => DocKey::Id,
                    b"metadata" => DocKey::Metadata,
                    b"records" => DocKey::Records,
                    _ => DocKey::Other,
                })
            }
        }
        deserializer.deserialize_identifier(V)
    }
}

struct ParsedDocFields {
    doc_id: String,
    meta: DocMetadata,
    days: BTreeMap<String, ProjectDayBucket>,
    has_records: bool,
}

struct LedgerDocSeed<'a> {
    query: &'a LedgerProjectQuery,
    tz_out_of_bounds: &'a mut bool,
}

impl<'de, 'a> DeserializeSeed<'de> for LedgerDocSeed<'a> {
    type Value = ParsedDocFields;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct V<'a> {
            query: &'a LedgerProjectQuery,
            tz_out_of_bounds: &'a mut bool,
        }

        impl<'de, 'a> Visitor<'de> for V<'a> {
            type Value = ParsedDocFields;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("ledger document object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut out = ParsedDocFields {
                    doc_id: String::new(),
                    meta: DocMetadata::default(),
                    days: BTreeMap::new(),
                    has_records: false,
                };
                while let Some(key) = map.next_key::<DocKey>()? {
                    match key {
                        DocKey::Id => {
                            out.doc_id = map.next_value_seed(OptStringSeed)?.unwrap_or_default();
                        }
                        DocKey::Metadata => {
                            out.meta = map.next_value_seed(MetadataSeed)?;
                        }
                        DocKey::Records => {
                            map.next_value_seed(RecordsSeed {
                                query: self.query,
                                days: &mut out.days,
                                tz_out_of_bounds: self.tz_out_of_bounds,
                            })?;
                            out.has_records = true;
                        }
                        DocKey::Other => {
                            let _ = map.next_value::<IgnoredAny>()?;
                        }
                    }
                }
                Ok(out)
            }
        }

        deserializer.deserialize_map(V {
            query: self.query,
            tz_out_of_bounds: self.tz_out_of_bounds,
        })
    }
}

enum ParseProjectFileStatus {
    Parsed(CachedProjectFileEntry),
    Missing,
    TransientError,
    TzOutOfBounds,
}

fn parse_project_ledger_file(
    query: &LedgerProjectQuery,
    file_name: &str,
    path: &Path,
    mtime_ns: i128,
    file_size: u64,
) -> ParseProjectFileStatus {
    let make_unreadable = || {
        ParseProjectFileStatus::Parsed(CachedProjectFileEntry {
            scope: query.scope.clone(),
            file_name: file_name.to_string(),
            mtime_ns,
            file_size,
            unreadable: true,
            doc_id: String::new(),
            source: String::new(),
            project_name: String::new(),
            note: String::new(),
            days: Vec::new(),
        })
    };

    if file_size > MAX_RECORD_FILE_BYTES {
        return make_unreadable();
    }
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return ParseProjectFileStatus::Missing,
        Err(_) => return ParseProjectFileStatus::TransientError,
    };
    if bytes.len() as u64 > MAX_RECORD_FILE_BYTES {
        return make_unreadable();
    }

    let mut tz_out_of_bounds = false;
    let mut de = serde_json::Deserializer::from_slice(&bytes);
    let parsed = LedgerDocSeed {
        query,
        tz_out_of_bounds: &mut tz_out_of_bounds,
    }
    .deserialize(&mut de);

    if tz_out_of_bounds {
        return ParseProjectFileStatus::TzOutOfBounds;
    }
    let Ok(doc) = parsed else {
        return make_unreadable();
    };
    if de.end().is_err() || !doc.has_records {
        return make_unreadable();
    }

    ParseProjectFileStatus::Parsed(CachedProjectFileEntry {
        scope: query.scope.clone(),
        file_name: file_name.to_string(),
        mtime_ns,
        file_size,
        unreadable: false,
        doc_id: doc.doc_id,
        source: doc.meta.source,
        project_name: doc.meta.project_name,
        note: doc.meta.note,
        days: doc.days.into_values().collect(),
    })
}

fn load_project_binary_cache(
    path: &Path,
    expected_tz_sig: &[u8; 32],
) -> (HashMap<(String, String), CachedProjectFileEntry>, bool) {
    let Ok(bytes) = fs::read(path) else {
        return (HashMap::new(), true);
    };
    if bytes.len() < 8 + 4 + 32 + 4 + 8 {
        return (HashMap::new(), true);
    }
    let payload_end = bytes.len() - 8;
    let payload = &bytes[..payload_end];
    let checksum = &bytes[payload_end..];
    let digest = Sha256::digest(payload);
    if &digest[..8] != checksum {
        return (HashMap::new(), true);
    }

    let Some((cached_tz_sig, entries)) = decode_project_binary_payload(payload) else {
        return (HashMap::new(), true);
    };
    if &cached_tz_sig != expected_tz_sig {
        return (HashMap::new(), true);
    }

    let mut map = HashMap::with_capacity(entries.len());
    for e in entries {
        map.insert((e.scope.clone(), e.file_name.clone()), e);
    }
    (map, false)
}

fn decode_project_binary_payload(
    payload: &[u8],
) -> Option<([u8; 32], Vec<CachedProjectFileEntry>)> {
    let mut cur = BinCursor::new(payload);
    if cur.read_bytes(8)? != PROJECT_CACHE_MAGIC {
        return None;
    }
    if cur.read_u32()? != PROJECT_CACHE_VERSION {
        return None;
    }
    let tz_sig_slice = cur.read_bytes(32)?;
    let tz_sig: [u8; 32] = tz_sig_slice.try_into().ok()?;
    let count = cur.read_u32()? as usize;
    let mut out = Vec::with_capacity(count.min(4096));
    for _ in 0..count {
        let scope = cur.read_str()?;
        let file_name = cur.read_str()?;
        let mtime_ns = cur.read_i128()?;
        let file_size = cur.read_u64()?;
        let flags = cur.read_u8()?;
        let unreadable = (flags & 0x01) != 0;

        let mut doc_id = String::new();
        let mut source = String::new();
        let mut project_name = String::new();
        let mut note = String::new();
        let mut days = Vec::new();

        if !unreadable {
            doc_id = cur.read_str()?;
            source = cur.read_str()?;
            project_name = cur.read_str()?;
            note = cur.read_str()?;
            let day_count = cur.read_u32()? as usize;
            days.reserve(day_count.min(1024));
            for _ in 0..day_count {
                let date = cur.read_str()?;
                if date.is_empty() || date.len() > 32 {
                    return None;
                }
                let uncached = cur.read_i64()?;
                let cache_read = cur.read_i64()?;
                let cache_write = cur.read_i64()?;
                let output = cur.read_i64()?;
                let requests = cur.read_i64()?;
                let max_at = cur.read_i64()?;
                if uncached < 0
                    || cache_read < 0
                    || cache_write < 0
                    || output < 0
                    || requests < 0
                    || !(0..=MAX_SAFE_INT).contains(&max_at)
                {
                    return None;
                }
                days.push(ProjectDayBucket {
                    date,
                    uncached,
                    cache_read,
                    cache_write,
                    output,
                    requests,
                    max_at,
                });
            }
        }
        out.push(CachedProjectFileEntry {
            scope,
            file_name,
            mtime_ns,
            file_size,
            unreadable,
            doc_id,
            source,
            project_name,
            note,
            days,
        });
    }
    if cur.pos != payload.len() {
        return None;
    }
    Some((tz_sig, out))
}

fn encode_project_binary_cache(
    tz_signature: &[u8; 32],
    entries: &[&CachedProjectFileEntry],
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(entries.len() * 192 + 64);
    buf.extend_from_slice(PROJECT_CACHE_MAGIC);
    buf.extend_from_slice(&PROJECT_CACHE_VERSION.to_le_bytes());
    buf.extend_from_slice(tz_signature);
    buf.extend_from_slice(&(entries.len() as u32).to_le_bytes());

    for e in entries {
        write_str(&mut buf, &e.scope);
        write_str(&mut buf, &e.file_name);
        buf.extend_from_slice(&e.mtime_ns.to_le_bytes());
        buf.extend_from_slice(&e.file_size.to_le_bytes());
        let flags: u8 = if e.unreadable { 0x01 } else { 0 };
        buf.push(flags);
        if !e.unreadable {
            write_str(&mut buf, &e.doc_id);
            write_str(&mut buf, &e.source);
            write_str(&mut buf, &e.project_name);
            write_str(&mut buf, &e.note);
            buf.extend_from_slice(&(e.days.len() as u32).to_le_bytes());
            for d in &e.days {
                write_str(&mut buf, &d.date);
                buf.extend_from_slice(&d.uncached.to_le_bytes());
                buf.extend_from_slice(&d.cache_read.to_le_bytes());
                buf.extend_from_slice(&d.cache_write.to_le_bytes());
                buf.extend_from_slice(&d.output.to_le_bytes());
                buf.extend_from_slice(&d.requests.to_le_bytes());
                buf.extend_from_slice(&d.max_at.to_le_bytes());
            }
        }
    }

    let digest = Sha256::digest(&buf);
    buf.extend_from_slice(&digest[..8]);
    buf
}

fn persist_project_cache(
    dir: &Path,
    tz_signature: &[u8; 32],
    entries: &HashMap<(String, String), CachedProjectFileEntry>,
) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let cache_path = dir.join(PROJECT_CACHE_FILE);
    if entries.is_empty() && !cache_path.exists() {
        return true;
    }
    let mut sorted: Vec<&CachedProjectFileEntry> = entries.values().collect();
    sorted.sort_by(|a, b| {
        a.scope
            .cmp(&b.scope)
            .then_with(|| a.file_name.cmp(&b.file_name))
    });
    let encoded = encode_project_binary_cache(tz_signature, &sorted);
    atomic_write_cache_file(dir, PROJECT_CACHE_FILE, &encoded)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectDayBucketOut<'a> {
    date: &'a str,
    uncached: i64,
    cache_read: i64,
    cache_write: i64,
    output: i64,
    requests: i64,
    max_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectFileSummaryOut<'a> {
    file_hash: &'a str,
    doc_id: &'a str,
    source: &'a str,
    project_name: &'a str,
    note: &'a str,
    days: Vec<ProjectDayBucketOut<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSummariesOut<'a> {
    scope: &'a str,
    time_zone: &'a str,
    files: Vec<ProjectFileSummaryOut<'a>>,
}

struct ProjectDirtyTask {
    name: String,
    path: PathBuf,
    mtime_ns: i128,
    file_size: u64,
}

pub fn read_ledger_project_summaries_json(query_json: &str) -> Option<String> {
    let query: LedgerProjectQuery = serde_json::from_str(query_json).ok()?;
    if query.directory.is_empty() || !is_hex64(&query.scope) || query.zero_at_date.is_empty() {
        return None;
    }

    let tz_signature = compute_tz_signature(&query);
    let dir = Path::new(&query.directory);
    let cache_path = dir.join(PROJECT_CACHE_FILE);
    let (bin_mtime_ns, bin_size) = read_cache_file_stamp(&cache_path);

    let mem_hit = if bin_size.is_none() || bin_mtime_ns.is_some() {
        let guard = PROJECT_MEM_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        guard.single_scope.as_ref().and_then(|c| {
            if c.directory == query.directory
                && c.bin_mtime_ns == bin_mtime_ns
                && c.bin_size == bin_size
                && c.tz_signature == tz_signature
            {
                Some(Arc::clone(&c.entries))
            } else {
                None
            }
        })
    } else {
        None
    };

    let was_mem_hit = mem_hit.is_some();
    let (mut cache_arc, mut cache_dirty) = match mem_hit {
        Some(arc) => (arc, false),
        None => {
            let (map, dirty) = load_project_binary_cache(&cache_path, &tz_signature);
            (Arc::new(map), dirty)
        }
    };

    let dirty_set: HashSet<String> = query
        .dirty_rel_paths
        .iter()
        .map(|p| p.replace('\\', "/"))
        .collect();

    let scope_dir = dir.join(&query.scope);
    let mut valid_files = Vec::new();
    match fs::read_dir(&scope_dir) {
        Ok(rd) => {
            for entry in rd {
                let Ok(entry) = entry else {
                    return None;
                };
                if let Some(name) = entry.file_name().to_str() {
                    if is_ledger_file_name(name) {
                        valid_files.push(name.to_string());
                    }
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return None,
    }
    valid_files.sort();
    let valid_set: HashSet<&str> = valid_files.iter().map(|n| n.as_str()).collect();

    let has_removed = cache_arc
        .keys()
        .any(|(cs, cname)| cs == &query.scope && !valid_set.contains(cname.as_str()));
    if has_removed {
        let keys_to_remove: Vec<(String, String)> = cache_arc
            .keys()
            .filter(|(cs, cname)| cs == &query.scope && !valid_set.contains(cname.as_str()))
            .cloned()
            .collect();
        let cache_map = Arc::make_mut(&mut cache_arc);
        for k in keys_to_remove {
            cache_map.remove(&k);
            cache_dirty = true;
        }
    }

    let mut existing_files = Vec::with_capacity(valid_files.len());
    let mut dirty_tasks: Vec<ProjectDirtyTask> = Vec::new();

    for name in valid_files {
        let full_path = scope_dir.join(&name);
        let file_meta = match fs::metadata(&full_path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let key = (query.scope.clone(), name);
                if cache_arc.contains_key(&key) {
                    Arc::make_mut(&mut cache_arc).remove(&key);
                    cache_dirty = true;
                }
                continue;
            }
            Err(_) => return None,
        };
        let mtime_ns = mtime_ns_from_metadata(&file_meta)?;
        let file_size = file_meta.len();
        let rel_path = format!("{}/{name}", query.scope);
        let is_dirty = dirty_set.contains(&rel_path);
        let cache_hit = !is_dirty
            && cache_arc
                .get(&(query.scope.clone(), name.clone()))
                .is_some_and(|e| e.mtime_ns == mtime_ns && e.file_size == file_size);
        if !cache_hit {
            dirty_tasks.push(ProjectDirtyTask {
                name: name.clone(),
                path: full_path,
                mtime_ns,
                file_size,
            });
        }
        existing_files.push(name);
    }

    if !dirty_tasks.is_empty() {
        let mut results: Vec<Option<ParseProjectFileStatus>> =
            (0..dirty_tasks.len()).map(|_| None).collect();
        let abort_flag = AtomicBool::new(false);
        if dirty_tasks.len() > PARALLEL_DIRTY_THRESHOLD {
            let next_idx = AtomicUsize::new(0);
            let workers = std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(4)
                .clamp(1, 8)
                .min(dirty_tasks.len());
            let handles: Vec<_> = std::thread::scope(|scope_handle| {
                let mut threads = Vec::with_capacity(workers);
                for _ in 0..workers {
                    threads.push(scope_handle.spawn(|| {
                        let mut local = Vec::new();
                        loop {
                            if abort_flag.load(Ordering::Relaxed) {
                                break;
                            }
                            let idx = next_idx.fetch_add(1, Ordering::Relaxed);
                            if idx >= dirty_tasks.len() {
                                break;
                            }
                            let task = &dirty_tasks[idx];
                            let status = parse_project_ledger_file(
                                &query,
                                &task.name,
                                &task.path,
                                task.mtime_ns,
                                task.file_size,
                            );
                            if matches!(
                                status,
                                ParseProjectFileStatus::TransientError
                                    | ParseProjectFileStatus::TzOutOfBounds
                            ) {
                                abort_flag.store(true, Ordering::Relaxed);
                                break;
                            }
                            local.push((idx, status));
                        }
                        local
                    }));
                }
                threads.into_iter().filter_map(|h| h.join().ok()).collect()
            });
            for local in handles {
                for (idx, status) in local {
                    results[idx] = Some(status);
                }
            }
        } else {
            for (idx, task) in dirty_tasks.iter().enumerate() {
                let status = parse_project_ledger_file(
                    &query,
                    &task.name,
                    &task.path,
                    task.mtime_ns,
                    task.file_size,
                );
                if matches!(
                    status,
                    ParseProjectFileStatus::TransientError
                        | ParseProjectFileStatus::TzOutOfBounds
                ) {
                    abort_flag.store(true, Ordering::Relaxed);
                    break;
                }
                results[idx] = Some(status);
            }
        }
        if abort_flag.load(Ordering::Relaxed) {
            return None;
        }
        let cache_map = Arc::make_mut(&mut cache_arc);
        for (idx, task) in dirty_tasks.into_iter().enumerate() {
            match results[idx].take()? {
                ParseProjectFileStatus::Parsed(entry) => {
                    cache_map.insert((query.scope.clone(), task.name), entry);
                    cache_dirty = true;
                }
                ParseProjectFileStatus::Missing => {
                    if cache_map
                        .remove(&(query.scope.clone(), task.name))
                        .is_some()
                    {
                        cache_dirty = true;
                    }
                }
                ParseProjectFileStatus::TransientError
                | ParseProjectFileStatus::TzOutOfBounds => return None,
            }
        }
    }

    if cache_dirty {
        Arc::make_mut(&mut cache_arc).shrink_to_fit();
        let persisted = persist_project_cache(dir, &tz_signature, &cache_arc);
        let (new_mtime_ns, new_size) = read_cache_file_stamp(&cache_path);
        let mut guard = PROJECT_MEM_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if persisted && (new_size.is_none() || new_mtime_ns.is_some()) {
            guard.single_scope = Some(InMemProjectCache {
                directory: query.directory.clone(),
                bin_mtime_ns: new_mtime_ns,
                bin_size: new_size,
                tz_signature,
                entries: Arc::clone(&cache_arc),
            });
        } else if guard
            .single_scope
            .as_ref()
            .is_some_and(|c| c.directory == query.directory)
        {
            guard.single_scope = None;
        }
    } else if !was_mem_hit && (bin_size.is_none() || bin_mtime_ns.is_some()) {
        let mut guard = PROJECT_MEM_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        guard.single_scope = Some(InMemProjectCache {
            directory: query.directory.clone(),
            bin_mtime_ns,
            bin_size,
            tz_signature,
            entries: Arc::clone(&cache_arc),
        });
    }

    let mut files_out = Vec::with_capacity(existing_files.len());
    for name in &existing_files {
        let Some(entry) = cache_arc.get(&(query.scope.clone(), name.clone())) else {
            continue;
        };
        if entry.unreadable {
            continue;
        }
        let days = entry
            .days
            .iter()
            .map(|d| ProjectDayBucketOut {
                date: &d.date,
                uncached: d.uncached,
                cache_read: d.cache_read,
                cache_write: d.cache_write,
                output: d.output,
                requests: d.requests,
                max_at: d.max_at,
            })
            .collect();
        files_out.push(ProjectFileSummaryOut {
            file_hash: name.strip_suffix(".json").unwrap_or(name),
            doc_id: &entry.doc_id,
            source: &entry.source,
            project_name: &entry.project_name,
            note: &entry.note,
            days,
        });
    }

    let out = ProjectSummariesOut {
        scope: &query.scope,
        time_zone: &query.time_zone,
        files: files_out,
    };
    serde_json::to_string(&out).ok()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerSharedProjectQuery {
    pub directory: String,
    pub scope: String,
    pub time_zone: String,
    #[serde(default)]
    pub fixed_offset_secs: Option<i32>,
    #[serde(default)]
    pub tz_min_ms: Option<i64>,
    #[serde(default)]
    pub tz_max_ms: Option<i64>,
    #[serde(default)]
    pub tz_transitions: Option<Vec<TzTransition>>,
    pub zero_at_date: String,
    #[serde(default, deserialize_with = "deserialize_known_accounts")]
    pub known_accounts: Vec<(String, KnownAccountInfo)>,
    #[serde(default)]
    pub fallback_scope: Option<String>,
    #[serde(default)]
    pub target_hashes: Option<Vec<String>>,
    #[serde(default)]
    pub dirty_rel_paths: Vec<String>,
}

struct SharedRecord {
    id: String,
    at: i64,
    uncached: i64,
    cache_read: i64,
    cache_write: i64,
    output: i64,
    is_legacy: bool,
}

impl SharedRecord {
    #[inline]
    fn sum(&self) -> i64 {
        self.uncached
            .saturating_add(self.cache_read)
            .saturating_add(self.cache_write)
            .saturating_add(self.output)
    }
}

struct ParsedSharedDoc {
    scope: String,
    file_hash: String,
    doc_id: String,
    source: String,
    project_name: String,
    note: String,
    file_marked_legacy: bool,
    records: Vec<SharedRecord>,
}

enum ParseSharedDocStatus {
    Valid(ParsedSharedDoc),
    InvalidOrMissing,
    TransientError,
}

struct SharedDocTask {
    scope: String,
    file_hash: String,
    path: PathBuf,
    exists: bool,
    file_size: u64,
}

fn read_validated_shared_doc(
    scope: &str,
    file_hash: &str,
    path: &Path,
    exists: bool,
    file_size: u64,
) -> ParseSharedDocStatus {
    if !exists || file_size > MAX_RECORD_FILE_BYTES {
        return ParseSharedDocStatus::InvalidOrMissing;
    }
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return ParseSharedDocStatus::InvalidOrMissing;
        }
        Err(_) => return ParseSharedDocStatus::TransientError,
    };
    if bytes.len() as u64 > MAX_RECORD_FILE_BYTES {
        return ParseSharedDocStatus::InvalidOrMissing;
    }
    let Ok(val) = serde_json::from_slice::<Value>(&bytes) else {
        return ParseSharedDocStatus::InvalidOrMissing;
    };
    let Some(obj) = val.as_object() else {
        return ParseSharedDocStatus::InvalidOrMissing;
    };
    if obj.get("schema").and_then(parse_safe_nonneg_int) != Some(1) {
        return ParseSharedDocStatus::InvalidOrMissing;
    }
    if obj.get("account").and_then(|v| v.as_str()) != Some(scope) {
        return ParseSharedDocStatus::InvalidOrMissing;
    }
    let Some(records_arr) = obj.get("records").and_then(|v| v.as_array()) else {
        return ParseSharedDocStatus::InvalidOrMissing;
    };

    let mut records = Vec::with_capacity(records_arr.len());
    for item in records_arr {
        let Some(robj) = item.as_object() else {
            return ParseSharedDocStatus::InvalidOrMissing;
        };
        let Some(rid) = robj.get("id").and_then(|v| v.as_str()) else {
            return ParseSharedDocStatus::InvalidOrMissing;
        };
        if !is_hex64(rid) {
            return ParseSharedDocStatus::InvalidOrMissing;
        }
        let Some(rmodel) = robj.get("model").and_then(|v| v.as_str()) else {
            return ParseSharedDocStatus::InvalidOrMissing;
        };
        if rmodel.encode_utf16().count() > 120 {
            return ParseSharedDocStatus::InvalidOrMissing;
        }
        let Ok(at) = parse_nullable_safe_int(robj.get("at")) else {
            return ParseSharedDocStatus::InvalidOrMissing;
        };
        let Ok(uncached) = parse_nullable_safe_int(robj.get("uncached")) else {
            return ParseSharedDocStatus::InvalidOrMissing;
        };
        let Ok(cache_read) = parse_nullable_safe_int(robj.get("cacheRead")) else {
            return ParseSharedDocStatus::InvalidOrMissing;
        };
        let Ok(cache_write) = parse_nullable_safe_int(robj.get("cacheWrite")) else {
            return ParseSharedDocStatus::InvalidOrMissing;
        };
        let Ok(output) = parse_nullable_safe_int(robj.get("output")) else {
            return ParseSharedDocStatus::InvalidOrMissing;
        };
        records.push(SharedRecord {
            id: rid.to_string(),
            at: at.unwrap_or(-1),
            uncached: uncached.unwrap_or(0),
            cache_read: cache_read.unwrap_or(0),
            cache_write: cache_write.unwrap_or(0),
            output: output.unwrap_or(0),
            is_legacy: robj.get("isLegacy").and_then(|v| v.as_bool()) == Some(true),
        });
    }

    let meta_obj = obj.get("metadata").and_then(|v| v.as_object());
    let file_marked_legacy = meta_obj
        .and_then(|m| m.get("isLegacy"))
        .and_then(|v| v.as_bool())
        == Some(true)
        || obj.get("isLegacy").and_then(|v| v.as_bool()) == Some(true);

    ParseSharedDocStatus::Valid(ParsedSharedDoc {
        scope: scope.to_string(),
        file_hash: file_hash.to_string(),
        doc_id: obj
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        source: meta_obj
            .and_then(|m| m.get("source"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        project_name: meta_obj
            .and_then(|m| m.get("projectName"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        note: meta_obj
            .and_then(|m| m.get("note"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        file_marked_legacy,
        records,
    })
}

fn empty_shared_summaries_json(scope: &str, time_zone: &str) -> Option<String> {
    let out = ProjectSummariesOut {
        scope,
        time_zone,
        files: Vec::new(),
    };
    serde_json::to_string(&out).ok()
}

/// Deduplicates and summarizes multi-scope shared ledger files across accounts in Rust.
pub fn read_ledger_shared_project_summaries_json(query_json: &str) -> Option<String> {
    let query: LedgerSharedProjectQuery = serde_json::from_str(query_json).ok()?;
    if query.directory.is_empty()
        || query.zero_at_date.is_empty()
        || (!is_hex64(&query.scope) && query.scope != "all")
    {
        return None;
    }

    let tz_signature = compute_tz_signature_parts(
        &query.time_zone,
        query.fixed_offset_secs,
        query.tz_min_ms,
        query.tz_max_ms,
        query.tz_transitions.as_deref(),
        &query.zero_at_date,
    );
    let known_accounts_hash = compute_known_accounts_hash(&query.known_accounts);
    let dir = Path::new(&query.directory);
    let accounts_stamp = read_cache_file_stamp(&dir.join("accounts-v1.json"));
    let ownership_stamp = read_cache_file_stamp(&dir.join("ownership-v1.json"));
    let stamps_valid = (accounts_stamp.1.is_none() || accounts_stamp.0.is_some())
        && (ownership_stamp.1.is_none() || ownership_stamp.0.is_some());

    let all_scopes = list_scope_directories(dir).ok()?;
    let target_scopes: Vec<String> = if query.scope == "all" {
        if !all_scopes.is_empty() {
            all_scopes.clone()
        } else if let Some(fb) = query.fallback_scope.as_ref().filter(|s| is_hex64(s)) {
            vec![fb.clone()]
        } else {
            Vec::new()
        }
    } else {
        vec![query.scope.clone()]
    };
    if target_scopes.is_empty() {
        return empty_shared_summaries_json(&query.scope, &query.time_zone);
    }

    let target_set: HashSet<String> = target_scopes.iter().cloned().collect();
    let scan_scopes: Vec<String> = if all_scopes.len() > 1 {
        let mut seen_sc = HashSet::new();
        let mut merged = Vec::new();
        for s in all_scopes.iter().chain(target_scopes.iter()) {
            if seen_sc.insert(s.clone()) {
                merged.push(s.clone());
            }
        }
        merged
    } else {
        target_scopes.clone()
    };

    let ownership = load_ownership(dir).ok()?;
    let mut owner_by_hash: HashMap<String, String> = HashMap::new();
    for (conv_id, owner_scope) in &ownership {
        if !conv_id.is_empty() && is_hex64(owner_scope) {
            owner_by_hash.insert(sha256_hex(&conv_id.to_ascii_lowercase()), owner_scope.clone());
        }
    }

    let mut scopes_by_hash: HashMap<String, Vec<String>> = HashMap::new();
    let mut target_scope_hashes: HashSet<String> = HashSet::new();
    for s in &scan_scopes {
        let scope_dir = dir.join(s);
        let is_target = target_set.contains(s);
        match fs::read_dir(&scope_dir) {
            Ok(rd) => {
                for entry in rd {
                    let Ok(entry) = entry else {
                        return None;
                    };
                    let Ok(ft) = entry.file_type() else {
                        continue;
                    };
                    if ft.is_dir() {
                        continue;
                    }
                    if let Some(name) = entry.file_name().to_str() {
                        if is_ledger_file_name(name) {
                            let file_hash = name[..64].to_string();
                            if is_target {
                                target_scope_hashes.insert(file_hash.clone());
                            }
                            scopes_by_hash.entry(file_hash).or_default().push(s.clone());
                        }
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return None,
        }
    }

    let mut shared_hashes: HashSet<String> = HashSet::new();
    for (file_hash, scopes_with_file) in &scopes_by_hash {
        let explicit_owner = owner_by_hash.get(file_hash);
        if scopes_with_file.len() > 1
            || explicit_owner.is_some_and(|eo| scopes_with_file.iter().any(|s| s != eo))
        {
            shared_hashes.insert(file_hash.clone());
        }
    }

    let req_filter: Option<HashSet<&str>> = query
        .target_hashes
        .as_ref()
        .map(|list| list.iter().map(|s| s.as_str()).collect());
    let mut sorted_hashes: Vec<String> = target_scope_hashes
        .into_iter()
        .filter(|h| shared_hashes.contains(h))
        .filter(|h| req_filter.as_ref().is_none_or(|f| f.contains(h.as_str())))
        .collect();
    sorted_hashes.sort();

    if sorted_hashes.is_empty() {
        return empty_shared_summaries_json(&query.scope, &query.time_zone);
    }

    let mut target_hasher = Sha256::new();
    target_hasher.update((sorted_hashes.len() as u32).to_le_bytes());
    for h in &sorted_hashes {
        target_hasher.update(h.as_bytes());
    }
    let target_hashes_hash: [u8; 32] = target_hasher.finalize().into();

    let dirty_set: HashSet<String> = query
        .dirty_rel_paths
        .iter()
        .map(|p| p.replace('\\', "/"))
        .collect();

    let mut tasks: Vec<SharedDocTask> = Vec::new();
    let mut stamp_hasher = Sha256::new();
    let mut any_dirty = false;

    for s in &scan_scopes {
        for file_hash in &sorted_hashes {
            if !scopes_by_hash
                .get(file_hash)
                .is_some_and(|list| list.iter().any(|x| x == s))
            {
                continue;
            }
            let file_name = format!("{file_hash}.json");
            let full_path = dir.join(s).join(&file_name);
            let rel_path = format!("{s}/{file_name}");
            if dirty_set.contains(&rel_path) {
                any_dirty = true;
            }
            let (exists, mtime_ns, file_size) = match fs::metadata(&full_path) {
                Ok(m) => (true, mtime_ns_from_metadata(&m)?, m.len()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (false, 0, 0),
                Err(_) => return None,
            };
            stamp_hasher.update(s.as_bytes());
            stamp_hasher.update(file_hash.as_bytes());
            stamp_hasher.update([if exists { 1u8 } else { 0u8 }]);
            stamp_hasher.update(mtime_ns.to_le_bytes());
            stamp_hasher.update(file_size.to_le_bytes());
            tasks.push(SharedDocTask {
                scope: s.clone(),
                file_hash: file_hash.clone(),
                path: full_path,
                exists,
                file_size,
            });
        }
    }
    let shared_files_stamp: [u8; 32] = stamp_hasher.finalize().into();

    if !any_dirty && stamps_valid {
        let guard = PROJECT_MEM_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(hit) = guard.shared.iter().find(|c| {
            c.directory == query.directory
                && c.scope == query.scope
                && c.tz_signature == tz_signature
                && c.ownership_stamp == ownership_stamp
                && c.accounts_stamp == accounts_stamp
                && c.shared_files_stamp == shared_files_stamp
                && c.known_accounts_hash == known_accounts_hash
                && c.target_hashes_hash == target_hashes_hash
        }) {
            return Some(hit.output_json.clone());
        }
    }

    let mut parse_results: Vec<Option<ParseSharedDocStatus>> =
        (0..tasks.len()).map(|_| None).collect();
    let transient_err = AtomicBool::new(false);
    if tasks.len() > PARALLEL_DIRTY_THRESHOLD {
        let next_idx = AtomicUsize::new(0);
        let workers = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .clamp(1, 8)
            .min(tasks.len());
        let handles: Vec<_> = std::thread::scope(|scope_handle| {
            let mut threads = Vec::with_capacity(workers);
            for _ in 0..workers {
                threads.push(scope_handle.spawn(|| {
                    let mut local = Vec::new();
                    loop {
                        if transient_err.load(Ordering::Relaxed) {
                            break;
                        }
                        let idx = next_idx.fetch_add(1, Ordering::Relaxed);
                        if idx >= tasks.len() {
                            break;
                        }
                        let t = &tasks[idx];
                        let status = read_validated_shared_doc(
                            &t.scope,
                            &t.file_hash,
                            &t.path,
                            t.exists,
                            t.file_size,
                        );
                        if matches!(status, ParseSharedDocStatus::TransientError) {
                            transient_err.store(true, Ordering::Relaxed);
                            break;
                        }
                        local.push((idx, status));
                    }
                    local
                }));
            }
            threads.into_iter().filter_map(|h| h.join().ok()).collect()
        });
        for local in handles {
            for (idx, status) in local {
                parse_results[idx] = Some(status);
            }
        }
    } else {
        for (idx, t) in tasks.iter().enumerate() {
            let status = read_validated_shared_doc(
                &t.scope,
                &t.file_hash,
                &t.path,
                t.exists,
                t.file_size,
            );
            if matches!(status, ParseSharedDocStatus::TransientError) {
                transient_err.store(true, Ordering::Relaxed);
                break;
            }
            parse_results[idx] = Some(status);
        }
    }
    if transient_err.load(Ordering::Relaxed) {
        return None;
    }

    let mut parsed_docs: Vec<ParsedSharedDoc> = Vec::with_capacity(tasks.len());
    for slot in parse_results {
        match slot? {
            ParseSharedDocStatus::Valid(doc) => parsed_docs.push(doc),
            ParseSharedDocStatus::InvalidOrMissing => {}
            ParseSharedDocStatus::TransientError => return None,
        }
    }

    let out_json = if parsed_docs.is_empty() {
        empty_shared_summaries_json(&query.scope, &query.time_zone)?
    } else {
        let mut record_scopes: HashMap<String, Vec<String>> = HashMap::new();
        let mut doc_by_scope_hash: HashMap<(String, String), usize> =
            HashMap::with_capacity(parsed_docs.len());
        for (doc_idx, doc) in parsed_docs.iter().enumerate() {
            doc_by_scope_hash.insert((doc.scope.clone(), doc.file_hash.clone()), doc_idx);
            for r in &doc.records {
                let list = record_scopes.entry(r.id.clone()).or_default();
                if !list.iter().any(|existing| existing == &doc.scope) {
                    list.push(doc.scope.clone());
                }
            }
        }

        let meta = load_accounts_meta(dir).ok()?;
        let known_keys: Vec<String> = query.known_accounts.iter().map(|(k, _)| k.clone()).collect();
        let known_map: HashMap<String, &KnownAccountInfo> = query
            .known_accounts
            .iter()
            .map(|(k, v)| (k.clone(), v))
            .collect();
        let known_index: HashMap<&str, usize> = known_keys
            .iter()
            .enumerate()
            .map(|(i, k)| (k.as_str(), i))
            .collect();

        struct SeenShared<'a> {
            record: &'a SharedRecord,
            file_hash: &'a str,
            doc_idx: usize,
            is_legacy: bool,
        }

        let mut seen_map: HashMap<&str, usize> = HashMap::new();
        let mut seen_vec: Vec<SeenShared<'_>> = Vec::new();

        for (doc_idx, doc) in parsed_docs.iter().enumerate() {
            let s = doc.scope.as_str();
            if !target_set.contains(s) {
                continue;
            }
            let explicit_owner = owner_by_hash.get(&doc.file_hash).map(|v| v.as_str());
            for r in &doc.records {
                let single_scope = [doc.scope.clone()];
                let scopes_for_record: &[String] = record_scopes
                    .get(&r.id)
                    .map(|v| v.as_slice())
                    .unwrap_or(&single_scope);
                let is_duplicate = scopes_for_record.len() > 1;
                let resolved_owner =
                    explicit_owner.filter(|eo| scopes_for_record.iter().any(|x| x == eo));
                if query.scope != "all" {
                    if let Some(ro) = resolved_owner {
                        if ro != s {
                            continue;
                        }
                    } else if is_duplicate
                        && pick_primary_scope(scopes_for_record, &meta, &known_map, &known_index)
                            .as_deref()
                            != Some(s)
                    {
                        continue;
                    }
                }
                let effective_owner = resolved_owner.or(if is_duplicate { None } else { Some(s) });
                let is_legacy = (effective_owner.is_none() && is_duplicate)
                    || (resolved_owner.is_none() && doc.file_marked_legacy);
                let r_sum = r.sum();
                if let Some(&idx) = seen_map.get(r.id.as_str()) {
                    let prev = &seen_vec[idx];
                    let prev_sum = prev.record.sum();
                    if r_sum > prev_sum {
                        seen_vec[idx] = SeenShared {
                            record: r,
                            file_hash: &doc.file_hash,
                            doc_idx,
                            is_legacy: is_legacy || r.is_legacy,
                        };
                    } else if r_sum == prev_sum && effective_owner == Some(s) && prev.is_legacy {
                        seen_vec[idx] = SeenShared {
                            record: r,
                            file_hash: &doc.file_hash,
                            doc_idx,
                            is_legacy: false,
                        };
                    }
                } else {
                    let idx = seen_vec.len();
                    seen_map.insert(r.id.as_str(), idx);
                    seen_vec.push(SeenShared {
                        record: r,
                        file_hash: &doc.file_hash,
                        doc_idx,
                        is_legacy: is_legacy || r.is_legacy,
                    });
                }
            }
        }

        struct SharedGroup<'a> {
            records: Vec<&'a SharedRecord>,
            doc_indices: Vec<usize>,
        }
        let mut by_hash_order: Vec<&str> = Vec::new();
        let mut by_hash: HashMap<&str, SharedGroup<'_>> = HashMap::new();
        for entry in seen_vec {
            let group = if let Some(g) = by_hash.get_mut(entry.file_hash) {
                g
            } else {
                by_hash_order.push(entry.file_hash);
                by_hash.entry(entry.file_hash).or_insert_with(|| SharedGroup {
                    records: Vec::new(),
                    doc_indices: Vec::new(),
                })
            };
            group.records.push(entry.record);
            if !group.doc_indices.contains(&entry.doc_idx) {
                group.doc_indices.push(entry.doc_idx);
            }
        }

        struct OwnedFileSummary {
            file_hash: String,
            doc_id: String,
            source: String,
            project_name: String,
            note: String,
            days: Vec<ProjectDayBucket>,
        }

        let mut owned_files: Vec<OwnedFileSummary> = Vec::with_capacity(by_hash_order.len());
        for file_hash in by_hash_order {
            let group = by_hash.get(file_hash)?;
            let explicit_owner = owner_by_hash.get(file_hash);
            let owner_doc_idx = explicit_owner
                .and_then(|eo| doc_by_scope_hash.get(&(eo.clone(), file_hash.to_string())).copied());
            let mut doc_id = String::new();
            let mut source = String::new();
            let mut project_name = String::new();
            let mut note = String::new();
            for doc_idx in owner_doc_idx.into_iter().chain(group.doc_indices.iter().copied()) {
                let d = &parsed_docs[doc_idx];
                if doc_id.is_empty() && !d.doc_id.is_empty() {
                    doc_id = d.doc_id.clone();
                }
                if source.is_empty() && !d.source.is_empty() {
                    source = d.source.clone();
                }
                if project_name.is_empty() && !d.project_name.is_empty() {
                    project_name = d.project_name.clone();
                }
                if note.is_empty() && !d.note.is_empty() {
                    note = d.note.clone();
                }
            }

            let mut days_map: BTreeMap<String, ProjectDayBucket> = BTreeMap::new();
            for rec in &group.records {
                let date_buf;
                let (date_str, rec_max_at): (&str, i64) = if rec.at <= 0 {
                    (query.zero_at_date.as_str(), 0)
                } else {
                    let (y, m, d, _hour) = date_ymd_hour_from_tz(
                        query.fixed_offset_secs,
                        query.tz_min_ms,
                        query.tz_max_ms,
                        query.tz_transitions.as_deref(),
                        rec.at,
                    )?;
                    date_buf = format_date_buf(y, m, d);
                    (std::str::from_utf8(&date_buf).ok()?, rec.at)
                };
                if let Some(bucket) = days_map.get_mut(date_str) {
                    bucket.uncached = bucket.uncached.saturating_add(rec.uncached);
                    bucket.cache_read = bucket.cache_read.saturating_add(rec.cache_read);
                    bucket.cache_write = bucket.cache_write.saturating_add(rec.cache_write);
                    bucket.output = bucket.output.saturating_add(rec.output);
                    bucket.requests += 1;
                    if rec_max_at > bucket.max_at {
                        bucket.max_at = rec_max_at;
                    }
                } else {
                    days_map.insert(
                        date_str.to_string(),
                        ProjectDayBucket {
                            date: date_str.to_string(),
                            uncached: rec.uncached,
                            cache_read: rec.cache_read,
                            cache_write: rec.cache_write,
                            output: rec.output,
                            requests: 1,
                            max_at: rec_max_at,
                        },
                    );
                }
            }

            owned_files.push(OwnedFileSummary {
                file_hash: file_hash.to_string(),
                doc_id,
                source,
                project_name,
                note,
                days: days_map.into_values().collect(),
            });
        }

        let files_out: Vec<ProjectFileSummaryOut<'_>> = owned_files
            .iter()
            .map(|f| ProjectFileSummaryOut {
                file_hash: &f.file_hash,
                doc_id: &f.doc_id,
                source: &f.source,
                project_name: &f.project_name,
                note: &f.note,
                days: f
                    .days
                    .iter()
                    .map(|d| ProjectDayBucketOut {
                        date: &d.date,
                        uncached: d.uncached,
                        cache_read: d.cache_read,
                        cache_write: d.cache_write,
                        output: d.output,
                        requests: d.requests,
                        max_at: d.max_at,
                    })
                    .collect(),
            })
            .collect();

        let out = ProjectSummariesOut {
            scope: &query.scope,
            time_zone: &query.time_zone,
            files: files_out,
        };
        serde_json::to_string(&out).ok()?
    };

    if stamps_valid {
        let mut guard = PROJECT_MEM_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        guard.shared.retain(|c| {
            !(c.directory == query.directory
                && c.scope == query.scope
                && c.tz_signature == tz_signature
                && c.target_hashes_hash == target_hashes_hash)
        });
        if guard.shared.len() >= MAX_SHARED_SNAPSHOT_SLOTS {
            guard.shared.remove(0);
        }
        let mut stored_json = out_json.clone();
        stored_json.shrink_to_fit();
        guard.shared.push(CachedSharedProjectSnapshot {
            directory: query.directory,
            scope: query.scope,
            tz_signature,
            ownership_stamp,
            accounts_stamp,
            shared_files_stamp,
            known_accounts_hash,
            target_hashes_hash,
            output_json: stored_json,
        });
        guard.shared.shrink_to_fit();
    }

    Some(out_json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::sync::atomic::AtomicU64;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        static TEST_SEQ: AtomicU64 = AtomicU64::new(0);
        let n = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "pulse-accel-proj-ledger-{label}-{}-{ts}-{n}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn hex64(ch: char) -> String {
        std::iter::repeat_n(ch, 64).collect()
    }

    fn write_raw_doc(dir: &Path, scope: &str, file_hash: &str, doc: Value) -> PathBuf {
        let scope_dir = dir.join(scope);
        fs::create_dir_all(&scope_dir).unwrap();
        let file_path = scope_dir.join(format!("{file_hash}.json"));
        fs::write(&file_path, serde_json::to_vec(&doc).unwrap()).unwrap();
        file_path
    }

    #[test]
    fn test_project_ledger_cold_warm_dirty_corrupt_and_delete() {
        let _lock = crate::ledger_index::CACHE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let dir = temp_dir("cache");
        let scope_a = hex64('a');
        let fhash1 = hex64('b');
        let fhash2 = hex64('c');
        let fhash_bad = hex64('d');
        let fhash_norec = hex64('e');
        let rid1 = hex64('1');

        let f1 = write_raw_doc(
            &dir,
            &scope_a,
            &fhash1,
            serde_json::json!({
                "schema": 99,
                "account": "unrelated-account",
                "id": "conv-1",
                "metadata": {
                    "source": "remote-manual",
                    "projectName": "AlphaProj",
                    "note": "Initial note"
                },
                "records": [{
                    "id": rid1,
                    "at": 1791684000000i64,
                    "model": "Gemini 3.8",
                    "uncached": 100,
                    "cacheRead": 900,
                    "cacheWrite": 20,
                    "output": 80
                }]
            }),
        );
        let f2 = write_raw_doc(
            &dir,
            &scope_a,
            &fhash2,
            serde_json::json!({
                "records": [{
                    "id": hex64('2'),
                    "at": null,
                    "model": "Gemini 3.8",
                    "uncached": 50,
                    "cacheRead": null,
                    "cacheWrite": 0,
                    "output": 25
                }]
            }),
        );
        // Unreadable files: broken JSON and missing records array
        let scope_dir = dir.join(&scope_a);
        fs::write(scope_dir.join(format!("{fhash_bad}.json")), b"{broken").unwrap();
        write_raw_doc(&dir, &scope_a, &fhash_norec, serde_json::json!({ "id": "x" }));

        let base_query = serde_json::json!({
            "directory": dir.to_string_lossy(),
            "scope": scope_a,
            "timeZone": "Asia/Shanghai",
            "fixedOffsetSecs": 28800,
            "zeroAtDate": "1970-01-01",
            "dirtyRelPaths": []
        });

        let out1: Value = serde_json::from_str(
            &read_ledger_project_summaries_json(&base_query.to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(out1["scope"], scope_a);
        assert_eq!(out1["timeZone"], "Asia/Shanghai");
        let files1 = out1["files"].as_array().unwrap();
        assert_eq!(files1.len(), 2);

        let f1_out = files1.iter().find(|f| f["fileHash"] == fhash1).unwrap();
        assert_eq!(f1_out["docId"], "conv-1");
        assert_eq!(f1_out["source"], "remote-manual");
        assert_eq!(f1_out["projectName"], "AlphaProj");
        assert_eq!(f1_out["note"], "Initial note");
        assert_eq!(f1_out["days"][0]["date"], "2026-10-11");
        assert_eq!(f1_out["days"][0]["uncached"], 100);
        assert_eq!(f1_out["days"][0]["cacheRead"], 900);
        assert_eq!(f1_out["days"][0]["cacheWrite"], 20);
        assert_eq!(f1_out["days"][0]["output"], 80);
        assert_eq!(f1_out["days"][0]["requests"], 1);
        assert_eq!(f1_out["days"][0]["maxAt"], 1791684000000i64);

        let f2_out = files1.iter().find(|f| f["fileHash"] == fhash2).unwrap();
        assert_eq!(f2_out["docId"], "");
        assert_eq!(f2_out["source"], "");
        assert_eq!(f2_out["days"][0]["date"], "1970-01-01");
        assert_eq!(f2_out["days"][0]["maxAt"], 0);
        assert_eq!(f2_out["days"][0]["uncached"], 50);
        assert_eq!(f2_out["days"][0]["output"], 25);

        let cache_path = dir.join(PROJECT_CACHE_FILE);
        assert!(cache_path.exists());
        assert!(!dir.join("ledger-compact-v1.bin").exists());
        let bin_bytes = fs::read(&cache_path).unwrap();
        assert_eq!(&bin_bytes[..8], PROJECT_CACHE_MAGIC);
        let stamp1 = read_cache_file_stamp(&cache_path);

        // Warm hit: binary stamp unchanged
        let out_warm: Value = serde_json::from_str(
            &read_ledger_project_summaries_json(&base_query.to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(out_warm, out1);
        assert_eq!(read_cache_file_stamp(&cache_path), stamp1);

        // Corrupt binary sidecar -> rebuilds gracefully
        fs::write(&cache_path, b"BADMAGIC").unwrap();
        let out_rebuilt: Value = serde_json::from_str(
            &read_ledger_project_summaries_json(&base_query.to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(out_rebuilt, out1);

        // Delete binary sidecar -> recreated
        fs::remove_file(&cache_path).unwrap();
        let out_recreated: Value = serde_json::from_str(
            &read_ledger_project_summaries_json(&base_query.to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(out_recreated, out1);
        assert!(cache_path.exists());

        // Same-size overwrite with dirtyRelPaths -> forces re-parse
        write_raw_doc(
            &dir,
            &scope_a,
            &fhash1,
            serde_json::json!({
                "schema": 99,
                "account": "unrelated-account",
                "id": "conv-1",
                "metadata": {
                    "source": "remote-manual",
                    "projectName": "AlphaProj",
                    "note": "Initial note"
                },
                "records": [{
                    "id": rid1,
                    "at": 1791684000000i64,
                    "model": "Gemini 3.8",
                    "uncached": 200,
                    "cacheRead": 800,
                    "cacheWrite": 20,
                    "output": 90
                }]
            }),
        );
        let mut dirty_query = base_query.clone();
        dirty_query["dirtyRelPaths"] = serde_json::json!([format!("{scope_a}/{fhash1}.json")]);
        let out_dirty: Value = serde_json::from_str(
            &read_ledger_project_summaries_json(&dirty_query.to_string()).unwrap(),
        )
        .unwrap();
        let f1_dirty = out_dirty["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["fileHash"] == fhash1)
            .unwrap();
        assert_eq!(f1_dirty["days"][0]["uncached"], 200);
        assert_eq!(f1_dirty["days"][0]["output"], 90);

        // Delete f2 and break f1 -> files drops f1 and f2
        fs::remove_file(&f2).unwrap();
        fs::write(&f1, b"{broken").unwrap();
        let mut dirty_query2 = base_query.clone();
        dirty_query2["dirtyRelPaths"] = serde_json::json!([format!("{scope_a}/{fhash1}.json")]);
        let out_after_del: Value = serde_json::from_str(
            &read_ledger_project_summaries_json(&dirty_query2.to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(out_after_del["files"].as_array().unwrap().len(), 0);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_project_ledger_valid_row_filtering_and_at_edge_cases() {
        let _lock = crate::ledger_index::CACHE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let dir = temp_dir("rows");
        let scope_a = hex64('a');
        let fhash = hex64('b');
        let emoji_61: String = std::iter::repeat_n('😀', 61).collect(); // 61 chars = 122 UTF-16 units (> 120!)
        let emoji_60: String = std::iter::repeat_n('😀', 60).collect(); // 60 chars = 120 UTF-16 units (<= 120)

        write_raw_doc(
            &dir,
            &scope_a,
            &fhash,
            serde_json::json!({
                "id": 12345, // non-string -> ""
                "metadata": { "source": null, "projectName": "P", "note": 42 },
                "records": [
                    null,
                    "not-an-object",
                    [1, 2],
                    { "id": "short", "at": 1791684000000i64, "model": "m", "uncached": 10, "cacheRead": 0, "cacheWrite": 0, "output": 0 },
                    { "id": hex64('1'), "at": 1791684000000i64, "model": emoji_61, "uncached": 10, "cacheRead": 0, "cacheWrite": 0, "output": 0 },
                    { "id": hex64('2'), "at": -1, "model": "m", "uncached": 10, "cacheRead": 0, "cacheWrite": 0, "output": 0 },
                    { "id": hex64('3'), "at": 1.5, "model": "m", "uncached": 10, "cacheRead": 0, "cacheWrite": 0, "output": 0 },
                    { "id": hex64('4'), "at": 9007199254740992i64, "model": "m", "uncached": 10, "cacheRead": 0, "cacheWrite": 0, "output": 0 },
                    { "id": hex64('5'), "at": 0, "model": "m", "uncached": 10, "cacheRead": 0, "cacheWrite": 0 }, // missing output
                    // Valid rows:
                    { "id": hex64('6'), "at": null, "model": emoji_60, "uncached": 30, "cacheRead": null, "cacheWrite": 5, "output": 10 },
                    { "id": hex64('7'), "at": 0, "model": "m", "uncached": 20, "cacheRead": 1, "cacheWrite": 0, "output": 4 },
                    { "id": hex64('8'), "at": 1791684000000i64, "model": "m", "uncached": 100.0, "cacheRead": 0, "cacheWrite": 0, "output": 50 },
                    { "id": hex64('9'), "at": 1791684005000i64, "model": "m", "uncached": 10, "cacheRead": 0, "cacheWrite": 0, "output": 5 }
                ]
            }),
        );

        let query = serde_json::json!({
            "directory": dir.to_string_lossy(),
            "scope": scope_a,
            "timeZone": "UTC",
            "fixedOffsetSecs": 0,
            "zeroAtDate": "1970-01-01",
            "dirtyRelPaths": []
        });

        let out: Value = serde_json::from_str(
            &read_ledger_project_summaries_json(&query.to_string()).unwrap(),
        )
        .unwrap();
        let file = &out["files"][0];
        assert_eq!(file["docId"], "");
        assert_eq!(file["source"], "");
        assert_eq!(file["projectName"], "P");
        assert_eq!(file["note"], "");

        let days = file["days"].as_array().unwrap();
        assert_eq!(days.len(), 2);
        assert_eq!(days[0]["date"], "1970-01-01");
        assert_eq!(days[0]["uncached"], 50);
        assert_eq!(days[0]["cacheRead"], 1);
        assert_eq!(days[0]["cacheWrite"], 5);
        assert_eq!(days[0]["output"], 14);
        assert_eq!(days[0]["requests"], 2);
        assert_eq!(days[0]["maxAt"], 0);

        assert_eq!(days[1]["date"], "2026-10-11");
        assert_eq!(days[1]["uncached"], 110);
        assert_eq!(days[1]["output"], 55);
        assert_eq!(days[1]["requests"], 2);
        assert_eq!(days[1]["maxAt"], 1791684005000i64);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_project_ledger_cross_scope_tz_change_and_parallel() {
        let _lock = crate::ledger_index::CACHE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let dir = temp_dir("cross-tz");
        let scope_a = hex64('a');
        let scope_b = hex64('b');
        // 2026-10-10T20:00:00Z -> UTC: 2026-10-10, Asia/Shanghai (+8h): 2026-10-11, NY (-4h EDT): 2026-10-10
        let at_ms: i64 = 1791662400000;

        // 12 files in scope_a (> PARALLEL_DIRTY_THRESHOLD)
        for i in 0..12u8 {
            let h = format!("{:064x}", i + 1);
            write_raw_doc(
                &dir,
                &scope_a,
                &h,
                serde_json::json!({
                    "id": format!("conv-a-{i}"),
                    "records": [{
                        "id": format!("{:064x}", i + 100),
                        "at": at_ms,
                        "model": "m",
                        "uncached": 10,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                        "output": 5
                    }]
                }),
            );
        }
        // 1 file in scope_b
        write_raw_doc(
            &dir,
            &scope_b,
            &hex64('f'),
            serde_json::json!({
                "id": "conv-b-0",
                "records": [{
                    "id": hex64('9'),
                    "at": at_ms,
                    "model": "m",
                    "uncached": 40,
                    "cacheRead": 0,
                    "cacheWrite": 0,
                    "output": 10
                }]
            }),
        );

        let q_a_utc = serde_json::json!({
            "directory": dir.to_string_lossy(),
            "scope": scope_a,
            "timeZone": "UTC",
            "fixedOffsetSecs": 0,
            "zeroAtDate": "1970-01-01",
            "dirtyRelPaths": []
        });
        let out_a_utc: Value = serde_json::from_str(
            &read_ledger_project_summaries_json(&q_a_utc.to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(out_a_utc["files"].as_array().unwrap().len(), 12);
        assert_eq!(out_a_utc["files"][0]["days"][0]["date"], "2026-10-10");

        let q_b_utc = serde_json::json!({
            "directory": dir.to_string_lossy(),
            "scope": scope_b,
            "timeZone": "UTC",
            "fixedOffsetSecs": 0,
            "zeroAtDate": "1970-01-01",
            "dirtyRelPaths": []
        });
        let out_b_utc: Value = serde_json::from_str(
            &read_ledger_project_summaries_json(&q_b_utc.to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(out_b_utc["files"].as_array().unwrap().len(), 1);
        assert_eq!(out_b_utc["files"][0]["docId"], "conv-b-0");

        // Verify both scopes are preserved in project-ledger-v1.bin
        let payload = fs::read(dir.join(PROJECT_CACHE_FILE)).unwrap();
        let (_sig, entries) =
            decode_project_binary_payload(&payload[..payload.len() - 8]).unwrap();
        assert_eq!(entries.len(), 13);

        // Switch timezone -> invalidates & rebuilds cleanly
        let q_a_sh = serde_json::json!({
            "directory": dir.to_string_lossy(),
            "scope": scope_a,
            "timeZone": "Asia/Shanghai",
            "fixedOffsetSecs": 28800,
            "zeroAtDate": "1970-01-01",
            "dirtyRelPaths": []
        });
        let out_a_sh: Value = serde_json::from_str(
            &read_ledger_project_summaries_json(&q_a_sh.to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(out_a_sh["files"].as_array().unwrap().len(), 12);
        assert_eq!(out_a_sh["files"][0]["days"][0]["date"], "2026-10-11");

        // Out-of-bounds tzMinMs/tzMaxMs -> returns None cleanly for TS fallback
        let q_oob = serde_json::json!({
            "directory": dir.to_string_lossy(),
            "scope": scope_a,
            "timeZone": "America/New_York",
            "tzMinMs": 1798761600000i64,
            "tzMaxMs": 1830297600000i64,
            "tzTransitions": [{ "atMs": 1798761600000i64, "offsetSecs": -18000 }],
            "zeroAtDate": "1969-12-31",
            "dirtyRelPaths": []
        });
        assert!(read_ledger_project_summaries_json(&q_oob.to_string()).is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_shared_project_summaries_parity_and_cache_release() {
        let _lock = crate::ledger_index::CACHE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        release_project_mem_cache();

        let dir = temp_dir("shared-parity");
        let scope_a = hex64('a');
        let scope_b = hex64('b');
        let conv_owned_b = "aaaaaaaa-1111-4111-8111-111111111111";
        let conv_legacy = "bbbbbbbb-2222-4222-8222-222222222222";
        let conv_split = "cccccccc-3333-4333-8333-333333333333";
        let conv_invalid = "dddddddd-4444-4444-8444-444444444444";

        let h_owned_b = sha256_hex(conv_owned_b);
        let h_legacy = sha256_hex(conv_legacy);
        let h_split = sha256_hex(conv_split);
        let h_invalid = sha256_hex(conv_invalid);

        fs::write(
            dir.join("accounts-v1.json"),
            serde_json::json!({
                "schema": 1,
                "accounts": {
                    scope_a.clone(): { "email": "a@example.test", "primary": true },
                    scope_b.clone(): { "email": "b@example.test", "primary": false }
                }
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            dir.join("ownership-v1.json"),
            serde_json::json!({
                conv_owned_b: scope_b.clone(),
                conv_split: scope_a.clone()
            })
            .to_string(),
        )
        .unwrap();

        let at_ms = 1791691200000i64; // 2026-10-11T04:00:00Z -> Asia/Shanghai 2026-10-11

        // 1) Shared in A & B, owned by B; A has stale metadata, B (ownerDoc) has authoritative docId/note
        write_raw_doc(
            &dir,
            &scope_a,
            &h_owned_b,
            serde_json::json!({
                "schema": 1,
                "account": scope_a,
                "id": conv_owned_b,
                "metadata": { "note": "From A" },
                "records": [{
                    "id": hex64('1'), "at": at_ms, "model": "m",
                    "uncached": 500, "cacheRead": 0, "cacheWrite": 0, "output": 200
                }]
            }),
        );
        write_raw_doc(
            &dir,
            &scope_b,
            &h_owned_b,
            serde_json::json!({
                "schema": 1,
                "account": scope_b,
                "id": conv_owned_b,
                "metadata": { "note": "Owner B note" },
                "records": [{
                    "id": hex64('1'), "at": at_ms, "model": "m",
                    "uncached": 500, "cacheRead": 0, "cacheWrite": 0, "output": 200
                }]
            }),
        );

        // 2) Legacy shared with NO ownership: overlapping r.id with higher token sum in B (350 vs 300)
        //    plus an at:null record in A mapped to zeroAtDate
        write_raw_doc(
            &dir,
            &scope_a,
            &h_legacy,
            serde_json::json!({
                "schema": 1,
                "account": scope_a,
                "id": conv_legacy,
                "records": [
                    {
                        "id": hex64('2'), "at": at_ms, "model": "m",
                        "uncached": 200, "cacheRead": 0, "cacheWrite": 0, "output": 100
                    },
                    {
                        "id": hex64('3'), "at": null, "model": "m",
                        "uncached": 40, "cacheRead": 0, "cacheWrite": 0, "output": 10
                    }
                ]
            }),
        );
        write_raw_doc(
            &dir,
            &scope_b,
            &h_legacy,
            serde_json::json!({
                "schema": 1,
                "account": scope_b,
                "id": conv_legacy,
                "records": [{
                    "id": hex64('2'), "at": at_ms, "model": "m",
                    "uncached": 250, "cacheRead": 0, "cacheWrite": 0, "output": 100
                }]
            }),
        );

        // 3) Split continuation owned by A with distinct records across A (250) and B (150)
        write_raw_doc(
            &dir,
            &scope_a,
            &h_split,
            serde_json::json!({
                "schema": 1,
                "account": scope_a,
                "id": conv_split,
                "records": [{
                    "id": hex64('4'), "at": at_ms, "model": "m",
                    "uncached": 200, "cacheRead": 0, "cacheWrite": 0, "output": 50
                }]
            }),
        );
        write_raw_doc(
            &dir,
            &scope_b,
            &h_split,
            serde_json::json!({
                "schema": 1,
                "account": scope_b,
                "id": conv_split,
                "records": [{
                    "id": hex64('5'), "at": at_ms + 1000, "model": "m",
                    "uncached": 100, "cacheRead": 0, "cacheWrite": 0, "output": 50
                }]
            }),
        );

        // 4) Invalid schema file in A & valid schema in B: schema!=1 doc is ignored cleanly
        write_raw_doc(
            &dir,
            &scope_a,
            &h_invalid,
            serde_json::json!({
                "schema": 99,
                "account": scope_a,
                "id": conv_invalid,
                "records": [{
                    "id": hex64('6'), "at": at_ms, "model": "m",
                    "uncached": 999, "cacheRead": 0, "cacheWrite": 0, "output": 0
                }]
            }),
        );
        write_raw_doc(
            &dir,
            &scope_b,
            &h_invalid,
            serde_json::json!({
                "schema": 1,
                "account": scope_b,
                "id": conv_invalid,
                "records": [{
                    "id": hex64('6'), "at": at_ms, "model": "m",
                    "uncached": 20, "cacheRead": 0, "cacheWrite": 0, "output": 5
                }]
            }),
        );

        let sum_tokens = |val: &Value, file_hash: &str| -> i64 {
            val["files"]
                .as_array()
                .unwrap()
                .iter()
                .find(|f| f["fileHash"] == file_hash)
                .map(|f| {
                    f["days"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|d| {
                            d["uncached"].as_i64().unwrap()
                                + d["cacheRead"].as_i64().unwrap()
                                + d["cacheWrite"].as_i64().unwrap()
                                + d["output"].as_i64().unwrap()
                        })
                        .sum()
                })
                .unwrap_or(0)
        };

        let q_a = serde_json::json!({
            "directory": dir.to_string_lossy(),
            "scope": scope_a,
            "timeZone": "Asia/Shanghai",
            "fixedOffsetSecs": 28800,
            "zeroAtDate": "1970-01-01",
            "knownAccounts": {
                scope_a.clone(): { "email": "a@example.test", "primary": true },
                scope_b.clone(): { "email": "b@example.test", "primary": false }
            },
            "dirtyRelPaths": []
        });
        let out_a: Value = serde_json::from_str(
            &read_ledger_shared_project_summaries_json(&q_a.to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(sum_tokens(&out_a, &h_owned_b), 0); // owned by B -> excluded from A
        assert_eq!(sum_tokens(&out_a, &h_legacy), 350); // primary A gets 300 + 50 (at:null)
        assert_eq!(sum_tokens(&out_a, &h_split), 250);
        assert_eq!(sum_tokens(&out_a, &h_invalid), 0); // invalid schema in A ignored

        let mut q_b = q_a.clone();
        q_b["scope"] = Value::String(scope_b.clone());
        let out_b: Value = serde_json::from_str(
            &read_ledger_shared_project_summaries_json(&q_b.to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(sum_tokens(&out_b, &h_owned_b), 700);
        let owned_b_file = out_b["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["fileHash"] == h_owned_b)
            .unwrap();
        assert_eq!(owned_b_file["note"], "Owner B note");
        assert_eq!(sum_tokens(&out_b, &h_legacy), 0); // primary is A
        assert_eq!(sum_tokens(&out_b, &h_split), 150);
        assert_eq!(sum_tokens(&out_b, &h_invalid), 25);

        let mut q_all = q_a.clone();
        q_all["scope"] = Value::String("all".to_string());
        let out_all: Value = serde_json::from_str(
            &read_ledger_shared_project_summaries_json(&q_all.to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(sum_tokens(&out_all, &h_owned_b), 700);
        assert_eq!(sum_tokens(&out_all, &h_legacy), 400); // max(300,350) + 50
        assert_eq!(sum_tokens(&out_all, &h_split), 400); // 250 + 150
        assert_eq!(sum_tokens(&out_all, &h_invalid), 25);

        // targetHashes subset filtering
        let mut q_sub = q_all.clone();
        q_sub["targetHashes"] = serde_json::json!([h_split]);
        let out_sub: Value = serde_json::from_str(
            &read_ledger_shared_project_summaries_json(&q_sub.to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(out_sub["files"].as_array().unwrap().len(), 1);
        assert_eq!(out_sub["files"][0]["fileHash"], h_split);

        // Cache hit & invalidation via dirtyRelPaths + release_project_mem_cache
        assert!(!PROJECT_MEM_CACHE
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .shared
            .is_empty());
        write_raw_doc(
            &dir,
            &scope_b,
            &h_split,
            serde_json::json!({
                "schema": 1,
                "account": scope_b,
                "id": conv_split,
                "records": [{
                    "id": hex64('5'), "at": at_ms + 1000, "model": "m",
                    "uncached": 300, "cacheRead": 0, "cacheWrite": 0, "output": 50
                }]
            }),
        );
        let mut q_dirty = q_sub.clone();
        q_dirty["dirtyRelPaths"] = serde_json::json!([format!("{scope_b}/{h_split}.json")]);
        let out_dirty: Value = serde_json::from_str(
            &read_ledger_shared_project_summaries_json(&q_dirty.to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(sum_tokens(&out_dirty, &h_split), 600);

        assert!(release_project_mem_cache());
        assert!(!release_project_mem_cache());

        let _ = fs::remove_dir_all(&dir);
    }
}
