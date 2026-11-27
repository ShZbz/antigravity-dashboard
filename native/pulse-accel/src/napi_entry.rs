use std::ffi::c_void;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;
use std::sync::OnceLock;

use crate::json_projector::project_trajectory_json;
use crate::ledger_index::{query_usage_ledger_summary_json, release_ledger_mem_cache};
use crate::log_rotator::rotate_log_tail_json;
use crate::project_ledger::{
    read_ledger_project_summaries_json, read_ledger_shared_project_summaries_json,
    release_project_mem_cache,
};
use crate::sanitizer_accel::{audit_open_source_privacy_json, sync_and_audit_open_source_json};
use crate::snapshot_diff::diff_session_snapshots_json;
use crate::sqlite_trajectory::{
    extract_sqlite_usage_records_json, read_sqlite_conversation_meta_json,
    read_sqlite_conversation_summaries_json, read_sqlite_trajectory_json_budgeted,
};
use crate::svg_compiler::{coalesce_swimlanes_json, compile_catmull_rom_svg_path_json};
use crate::transcript_scan::scan_transcript_file_json;
use crate::win32_discovery::discover_win32_processes_json;

pub type NapiEnv = *mut c_void;
pub type NapiValue = *mut c_void;
pub type NapiCallbackInfo = *mut c_void;
pub type NapiStatus = i32;
pub type NapiCallback = unsafe extern "C" fn(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue;

const NAPI_OK: NapiStatus = 0;

type FnGetCbInfo = unsafe extern "C" fn(
    env: NapiEnv,
    cbinfo: NapiCallbackInfo,
    argc: *mut usize,
    argv: *mut NapiValue,
    this_arg: *mut NapiValue,
    data: *mut *mut c_void,
) -> NapiStatus;

type FnGetValueStringUtf8 = unsafe extern "C" fn(
    env: NapiEnv,
    value: NapiValue,
    buf: *mut u8,
    bufsize: usize,
    result: *mut usize,
) -> NapiStatus;

type FnGetValueBool =
    unsafe extern "C" fn(env: NapiEnv, value: NapiValue, result: *mut bool) -> NapiStatus;

type FnGetValueDouble =
    unsafe extern "C" fn(env: NapiEnv, value: NapiValue, result: *mut f64) -> NapiStatus;

type FnCreateStringUtf8 = unsafe extern "C" fn(
    env: NapiEnv,
    str_ptr: *const u8,
    length: usize,
    result: *mut NapiValue,
) -> NapiStatus;

type FnGetNull = unsafe extern "C" fn(env: NapiEnv, result: *mut NapiValue) -> NapiStatus;

type FnGetAndClearLastException =
    unsafe extern "C" fn(env: NapiEnv, result: *mut NapiValue) -> NapiStatus;

type FnSetNamedProperty = unsafe extern "C" fn(
    env: NapiEnv,
    object: NapiValue,
    utf8name: *const u8,
    value: NapiValue,
) -> NapiStatus;

type FnCreateFunction = unsafe extern "C" fn(
    env: NapiEnv,
    utf8name: *const u8,
    length: usize,
    cb: NapiCallback,
    data: *mut c_void,
    result: *mut NapiValue,
) -> NapiStatus;

#[derive(Clone, Copy)]
struct NapiApi {
    get_cb_info: FnGetCbInfo,
    get_value_string_utf8: FnGetValueStringUtf8,
    get_value_bool: FnGetValueBool,
    get_value_double: Option<FnGetValueDouble>,
    create_string_utf8: FnCreateStringUtf8,
    get_null: FnGetNull,
    get_and_clear_last_exception: Option<FnGetAndClearLastException>,
    set_named_property: FnSetNamedProperty,
    create_function: FnCreateFunction,
}

static NAPI_API: OnceLock<Option<NapiApi>> = OnceLock::new();

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(lp_module_name: *const u16) -> *mut c_void;
    fn GetProcAddress(h_module: *mut c_void, lp_proc_name: *const u8) -> *mut c_void;
}

#[cfg(windows)]
unsafe fn resolve_symbol(name: &[u8]) -> *mut c_void {
    let main_mod = GetModuleHandleW(ptr::null());
    if !main_mod.is_null() {
        let addr = GetProcAddress(main_mod, name.as_ptr());
        if !addr.is_null() {
            return addr;
        }
    }
    let node_dll: [u16; 9] = [
        b'n' as u16, b'o' as u16, b'd' as u16, b'e' as u16, b'.' as u16,
        b'd' as u16, b'l' as u16, b'l' as u16, 0,
    ];
    let libnode_dll: [u16; 12] = [
        b'l' as u16, b'i' as u16, b'b' as u16, b'n' as u16, b'o' as u16, b'd' as u16,
        b'e' as u16, b'.' as u16, b'd' as u16, b'l' as u16, b'l' as u16, 0,
    ];
    let electron_dll: [u16; 13] = [
        b'e' as u16, b'l' as u16, b'e' as u16, b'c' as u16, b't' as u16, b'r' as u16,
        b'o' as u16, b'n' as u16, b'.' as u16, b'd' as u16, b'l' as u16, b'l' as u16, 0,
    ];
    for dll in [node_dll.as_ptr(), libnode_dll.as_ptr(), electron_dll.as_ptr()] {
        let dll_mod = GetModuleHandleW(dll);
        if !dll_mod.is_null() {
            let addr = GetProcAddress(dll_mod, name.as_ptr());
            if !addr.is_null() {
                return addr;
            }
        }
    }
    ptr::null_mut()
}

#[cfg(unix)]
extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const u8) -> *mut c_void;
}

#[cfg(unix)]
unsafe fn resolve_symbol(name: &[u8]) -> *mut c_void {
    #[cfg(target_os = "macos")]
    const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;
    #[cfg(not(target_os = "macos"))]
    const RTLD_DEFAULT: *mut c_void = ptr::null_mut();

    dlsym(RTLD_DEFAULT, name.as_ptr())
}

fn api() -> Option<&'static NapiApi> {
    NAPI_API
        .get_or_init(|| unsafe {
            let p_get_cb_info = resolve_symbol(b"napi_get_cb_info\0");
            let p_get_str = resolve_symbol(b"napi_get_value_string_utf8\0");
            let p_get_bool = resolve_symbol(b"napi_get_value_bool\0");
            let p_get_double = resolve_symbol(b"napi_get_value_double\0");
            let p_create_str = resolve_symbol(b"napi_create_string_utf8\0");
            let p_get_null = resolve_symbol(b"napi_get_null\0");
            let p_clear_exc = resolve_symbol(b"napi_get_and_clear_last_exception\0");
            let p_set_prop = resolve_symbol(b"napi_set_named_property\0");
            let p_create_fn = resolve_symbol(b"napi_create_function\0");

            if p_get_cb_info.is_null()
                || p_get_str.is_null()
                || p_get_bool.is_null()
                || p_create_str.is_null()
                || p_get_null.is_null()
                || p_set_prop.is_null()
                || p_create_fn.is_null()
            {
                return None;
            }

            Some(NapiApi {
                get_cb_info: std::mem::transmute::<*mut c_void, FnGetCbInfo>(p_get_cb_info),
                get_value_string_utf8: std::mem::transmute::<*mut c_void, FnGetValueStringUtf8>(
                    p_get_str,
                ),
                get_value_bool: std::mem::transmute::<*mut c_void, FnGetValueBool>(p_get_bool),
                get_value_double: if p_get_double.is_null() {
                    None
                } else {
                    Some(std::mem::transmute::<*mut c_void, FnGetValueDouble>(p_get_double))
                },
                create_string_utf8: std::mem::transmute::<*mut c_void, FnCreateStringUtf8>(
                    p_create_str,
                ),
                get_null: std::mem::transmute::<*mut c_void, FnGetNull>(p_get_null),
                get_and_clear_last_exception: if p_clear_exc.is_null() {
                    None
                } else {
                    Some(std::mem::transmute::<*mut c_void, FnGetAndClearLastException>(p_clear_exc))
                },
                set_named_property: std::mem::transmute::<*mut c_void, FnSetNamedProperty>(
                    p_set_prop,
                ),
                create_function: std::mem::transmute::<*mut c_void, FnCreateFunction>(p_create_fn),
            })
        })
        .as_ref()
}

unsafe fn js_null(napi: &NapiApi, env: NapiEnv) -> NapiValue {
    let mut out: NapiValue = ptr::null_mut();
    let _ = (napi.get_null)(env, &mut out);
    out
}

unsafe fn js_string_or_null(napi: &NapiApi, env: NapiEnv, val: Option<String>) -> NapiValue {
    match val {
        Some(s) => {
            let mut out: NapiValue = ptr::null_mut();
            if (napi.create_string_utf8)(env, s.as_ptr(), s.len(), &mut out) == NAPI_OK
                && !out.is_null()
            {
                out
            } else {
                if let Some(clear_exc) = napi.get_and_clear_last_exception {
                    let mut ignored: NapiValue = ptr::null_mut();
                    let _ = clear_exc(env, &mut ignored);
                }
                js_null(napi, env)
            }
        }
        None => js_null(napi, env),
    }
}

const MAX_NAPI_UTF8_BYTES: usize = 96 * 1024 * 1024;

unsafe fn extract_utf8_arg(napi: &NapiApi, env: NapiEnv, val: NapiValue) -> Option<String> {
    if val.is_null() {
        return None;
    }
    let mut len: usize = 0;
    if (napi.get_value_string_utf8)(env, val, ptr::null_mut(), 0, &mut len) != NAPI_OK {
        return None;
    }
    let buf_len = len.checked_add(1)?;
    if buf_len > MAX_NAPI_UTF8_BYTES {
        return None;
    }
    let mut buf = Vec::new();
    buf.try_reserve_exact(buf_len).ok()?;
    buf.resize(buf_len, 0);
    let mut written: usize = 0;
    if (napi.get_value_string_utf8)(env, val, buf.as_mut_ptr(), buf_len, &mut written) != NAPI_OK {
        return None;
    }
    buf.truncate(written);
    String::from_utf8(buf).ok()
}

unsafe fn extract_bool_arg(napi: &NapiApi, env: NapiEnv, val: NapiValue) -> bool {
    if val.is_null() {
        return false;
    }
    let mut res = false;
    if (napi.get_value_bool)(env, val, &mut res) == NAPI_OK {
        res
    } else {
        false
    }
}

unsafe fn extract_optional_usize_arg(
    napi: &NapiApi,
    env: NapiEnv,
    val: NapiValue,
) -> Option<usize> {
    if val.is_null() {
        return None;
    }
    let get_double = napi.get_value_double?;
    let mut res: f64 = 0.0;
    if get_double(env, val, &mut res) != NAPI_OK || !res.is_finite() || res <= 0.0 {
        return None;
    }
    let capped = res.min(usize::MAX as f64) as usize;
    if capped > 0 {
        Some(capped)
    } else {
        None
    }
}

unsafe fn extract_non_negative_u64_arg(
    napi: &NapiApi,
    env: NapiEnv,
    val: NapiValue,
) -> Option<u64> {
    if val.is_null() {
        return None;
    }
    let get_double = napi.get_value_double?;
    let mut res: f64 = 0.0;
    if get_double(env, val, &mut res) != NAPI_OK || !res.is_finite() || res < 0.0 {
        return None;
    }
    let floored = res.floor();
    if floored >= u64::MAX as f64 {
        Some(u64::MAX)
    } else {
        Some(floored as u64)
    }
}

unsafe extern "C" fn cb_extract_sqlite_usage_records_json(
    env: NapiEnv,
    info: NapiCallbackInfo,
) -> NapiValue {
    let Some(napi) = api() else {
        return ptr::null_mut();
    };
    let result = catch_unwind(AssertUnwindSafe(|| {
        let mut argc: usize = 2;
        let mut argv: [NapiValue; 2] = [ptr::null_mut(); 2];
        if (napi.get_cb_info)(
            env,
            info,
            &mut argc,
            argv.as_mut_ptr(),
            ptr::null_mut(),
            ptr::null_mut(),
        ) != NAPI_OK
            || argc < 2
        {
            return None;
        }
        let db_path = extract_utf8_arg(napi, env, argv[0])?;
        let conversation_id = extract_utf8_arg(napi, env, argv[1])?;
        extract_sqlite_usage_records_json(&db_path, &conversation_id)
    }));
    match result {
        Ok(opt) => js_string_or_null(napi, env, opt),
        Err(_) => js_null(napi, env),
    }
}

unsafe extern "C" fn cb_read_sqlite_trajectory_json(
    env: NapiEnv,
    info: NapiCallbackInfo,
) -> NapiValue {
    let Some(napi) = api() else {
        return ptr::null_mut();
    };
    let result = catch_unwind(AssertUnwindSafe(|| {
        let mut argc: usize = 4;
        let mut argv: [NapiValue; 4] = [ptr::null_mut(); 4];
        if (napi.get_cb_info)(
            env,
            info,
            &mut argc,
            argv.as_mut_ptr(),
            ptr::null_mut(),
            ptr::null_mut(),
        ) != NAPI_OK
            || argc < 2
        {
            return None;
        }
        let db_path = extract_utf8_arg(napi, env, argv[0])?;
        let conversation_id = extract_utf8_arg(napi, env, argv[1])?;
        let timeline_enabled = if argc >= 3 {
            extract_bool_arg(napi, env, argv[2])
        } else {
            false
        };
        let max_output_bytes = if argc >= 4 {
            extract_optional_usize_arg(napi, env, argv[3])
        } else {
            None
        };
        read_sqlite_trajectory_json_budgeted(
            &db_path,
            &conversation_id,
            timeline_enabled,
            max_output_bytes,
        )
    }));
    match result {
        Ok(opt) => js_string_or_null(napi, env, opt),
        Err(_) => js_null(napi, env),
    }
}

unsafe extern "C" fn cb_read_sqlite_conversation_meta_json(
    env: NapiEnv,
    info: NapiCallbackInfo,
) -> NapiValue {
    let Some(napi) = api() else {
        return ptr::null_mut();
    };
    let result = catch_unwind(AssertUnwindSafe(|| {
        let mut argc: usize = 2;
        let mut argv: [NapiValue; 2] = [ptr::null_mut(); 2];
        if (napi.get_cb_info)(
            env,
            info,
            &mut argc,
            argv.as_mut_ptr(),
            ptr::null_mut(),
            ptr::null_mut(),
        ) != NAPI_OK
            || argc < 2
        {
            return None;
        }
        let db_path = extract_utf8_arg(napi, env, argv[0])?;
        let conversation_id = extract_utf8_arg(napi, env, argv[1])?;
        read_sqlite_conversation_meta_json(&db_path, &conversation_id)
    }));
    match result {
        Ok(opt) => js_string_or_null(napi, env, opt),
        Err(_) => js_null(napi, env),
    }
}

unsafe extern "C" fn cb_read_sqlite_conversation_summaries_json(
    env: NapiEnv,
    info: NapiCallbackInfo,
) -> NapiValue {
    run_single_json_arg_cb(env, info, read_sqlite_conversation_summaries_json)
}

unsafe fn run_single_json_arg_cb(
    env: NapiEnv,
    info: NapiCallbackInfo,
    handler: fn(&str) -> Option<String>,
) -> NapiValue {
    let Some(napi) = api() else {
        return ptr::null_mut();
    };
    let result = catch_unwind(AssertUnwindSafe(|| {
        let mut argc: usize = 1;
        let mut argv: [NapiValue; 1] = [ptr::null_mut(); 1];
        if (napi.get_cb_info)(
            env,
            info,
            &mut argc,
            argv.as_mut_ptr(),
            ptr::null_mut(),
            ptr::null_mut(),
        ) != NAPI_OK
            || argc < 1
        {
            return None;
        }
        let arg_json = extract_utf8_arg(napi, env, argv[0])?;
        handler(&arg_json)
    }));
    match result {
        Ok(opt) => js_string_or_null(napi, env, opt),
        Err(_) => js_null(napi, env),
    }
}

unsafe extern "C" fn cb_diff_session_snapshots_json(
    env: NapiEnv,
    info: NapiCallbackInfo,
) -> NapiValue {
    run_single_json_arg_cb(env, info, diff_session_snapshots_json)
}

unsafe extern "C" fn cb_query_usage_ledger_summary_json(
    env: NapiEnv,
    info: NapiCallbackInfo,
) -> NapiValue {
    run_single_json_arg_cb(env, info, query_usage_ledger_summary_json)
}

unsafe extern "C" fn cb_read_ledger_project_summaries_json(
    env: NapiEnv,
    info: NapiCallbackInfo,
) -> NapiValue {
    run_single_json_arg_cb(env, info, read_ledger_project_summaries_json)
}

unsafe extern "C" fn cb_read_ledger_shared_project_summaries_json(
    env: NapiEnv,
    info: NapiCallbackInfo,
) -> NapiValue {
    run_single_json_arg_cb(env, info, read_ledger_shared_project_summaries_json)
}

/// Releases native in-memory ledger and project caches (`soft` keeps ledger snapshot + stamps; `full` clears all).
pub fn release_native_caches_json(mode: &str) -> Option<String> {
    let mode = mode.trim();
    if mode != "soft" && mode != "full" {
        return None;
    }
    let ledger_cleared = release_ledger_mem_cache(mode);
    let project_cleared = release_project_mem_cache();
    Some(format!(
        r#"{{"released":true,"mode":"{mode}","ledgerCleared":{ledger_cleared},"projectCleared":{project_cleared}}}"#
    ))
}

unsafe extern "C" fn cb_release_native_caches_json(
    env: NapiEnv,
    info: NapiCallbackInfo,
) -> NapiValue {
    run_single_json_arg_cb(env, info, release_native_caches_json)
}

unsafe extern "C" fn cb_audit_open_source_privacy_json(
    env: NapiEnv,
    info: NapiCallbackInfo,
) -> NapiValue {
    run_single_json_arg_cb(env, info, audit_open_source_privacy_json)
}

unsafe extern "C" fn cb_sync_and_audit_open_source_json(
    env: NapiEnv,
    info: NapiCallbackInfo,
) -> NapiValue {
    run_single_json_arg_cb(env, info, sync_and_audit_open_source_json)
}

unsafe extern "C" fn cb_coalesce_swimlanes_json(
    env: NapiEnv,
    info: NapiCallbackInfo,
) -> NapiValue {
    run_single_json_arg_cb(env, info, |arg| coalesce_swimlanes_json(arg).ok())
}

unsafe extern "C" fn cb_compile_catmull_rom_svg_path_json(
    env: NapiEnv,
    info: NapiCallbackInfo,
) -> NapiValue {
    run_single_json_arg_cb(env, info, |arg| compile_catmull_rom_svg_path_json(arg).ok())
}

unsafe extern "C" fn cb_project_trajectory_json(
    env: NapiEnv,
    info: NapiCallbackInfo,
) -> NapiValue {
    run_single_json_arg_cb(env, info, |arg| match project_trajectory_json(arg) {
        Ok(json) => Some(json),
        Err(err) if err.contains("超过") || err.contains("budget") => {
            Some(r#"{"__budgetExceeded":true}"#.to_string())
        }
        Err(_) => None,
    })
}

unsafe extern "C" fn cb_scan_transcript_file_json(
    env: NapiEnv,
    info: NapiCallbackInfo,
) -> NapiValue {
    run_single_json_arg_cb(env, info, |arg| scan_transcript_file_json(arg).ok())
}

unsafe extern "C" fn cb_discover_win32_processes_json(
    env: NapiEnv,
    _info: NapiCallbackInfo,
) -> NapiValue {
    let Some(napi) = api() else {
        return ptr::null_mut();
    };
    let result = catch_unwind(AssertUnwindSafe(|| discover_win32_processes_json().ok()));
    match result {
        Ok(opt) => js_string_or_null(napi, env, opt),
        Err(_) => js_null(napi, env),
    }
}

unsafe extern "C" fn cb_rotate_log_tail_json(
    env: NapiEnv,
    info: NapiCallbackInfo,
) -> NapiValue {
    let Some(napi) = api() else {
        return ptr::null_mut();
    };
    let result = catch_unwind(AssertUnwindSafe(|| {
        let mut argc: usize = 3;
        let mut argv: [NapiValue; 3] = [ptr::null_mut(); 3];
        if (napi.get_cb_info)(
            env,
            info,
            &mut argc,
            argv.as_mut_ptr(),
            ptr::null_mut(),
            ptr::null_mut(),
        ) != NAPI_OK
            || argc < 3
        {
            return None;
        }
        let log_path = extract_utf8_arg(napi, env, argv[0])?;
        let max_bytes = extract_non_negative_u64_arg(napi, env, argv[1])?;
        let keep_lines_u64 = extract_non_negative_u64_arg(napi, env, argv[2])?;
        let keep_lines = usize::try_from(keep_lines_u64).unwrap_or(usize::MAX);
        rotate_log_tail_json(&log_path, max_bytes, keep_lines)
    }));
    match result {
        Ok(opt) => js_string_or_null(napi, env, opt),
        Err(_) => js_null(napi, env),
    }
}

unsafe fn export_fn(
    napi: &NapiApi,
    env: NapiEnv,
    exports: NapiValue,
    name_with_nul: &[u8],
    cb: NapiCallback,
) {
    let name_len = name_with_nul.len().saturating_sub(1);
    let mut fn_val: NapiValue = ptr::null_mut();
    if (napi.create_function)(
        env,
        name_with_nul.as_ptr(),
        name_len,
        cb,
        ptr::null_mut(),
        &mut fn_val,
    ) == NAPI_OK
        && !fn_val.is_null()
    {
        let _ = (napi.set_named_property)(env, exports, name_with_nul.as_ptr(), fn_val);
    }
}

#[no_mangle]
pub unsafe extern "C" fn napi_register_module_v1(env: NapiEnv, exports: NapiValue) -> NapiValue {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if let Some(napi) = api() {
            export_fn(
                napi,
                env,
                exports,
                b"extractSqliteUsageRecordsJson\0",
                cb_extract_sqlite_usage_records_json,
            );
            export_fn(
                napi,
                env,
                exports,
                b"readSqliteTrajectoryJson\0",
                cb_read_sqlite_trajectory_json,
            );
            export_fn(
                napi,
                env,
                exports,
                b"readSqliteConversationMetaJson\0",
                cb_read_sqlite_conversation_meta_json,
            );
            export_fn(
                napi,
                env,
                exports,
                b"readSqliteConversationSummariesJson\0",
                cb_read_sqlite_conversation_summaries_json,
            );
            export_fn(
                napi,
                env,
                exports,
                b"diffSessionSnapshotsJson\0",
                cb_diff_session_snapshots_json,
            );
            export_fn(
                napi,
                env,
                exports,
                b"queryUsageLedgerSummaryJson\0",
                cb_query_usage_ledger_summary_json,
            );
            export_fn(
                napi,
                env,
                exports,
                b"readLedgerProjectSummariesJson\0",
                cb_read_ledger_project_summaries_json,
            );
            export_fn(
                napi,
                env,
                exports,
                b"readLedgerSharedProjectSummariesJson\0",
                cb_read_ledger_shared_project_summaries_json,
            );
            export_fn(
                napi,
                env,
                exports,
                b"releaseNativeCachesJson\0",
                cb_release_native_caches_json,
            );
            export_fn(
                napi,
                env,
                exports,
                b"auditOpenSourcePrivacyJson\0",
                cb_audit_open_source_privacy_json,
            );
            export_fn(
                napi,
                env,
                exports,
                b"syncAndAuditOpenSourceJson\0",
                cb_sync_and_audit_open_source_json,
            );
            export_fn(
                napi,
                env,
                exports,
                b"rotateLogTailJson\0",
                cb_rotate_log_tail_json,
            );
            export_fn(
                napi,
                env,
                exports,
                b"coalesceSwimlanesJson\0",
                cb_coalesce_swimlanes_json,
            );
            export_fn(
                napi,
                env,
                exports,
                b"compileCatmullRomSvgPathJson\0",
                cb_compile_catmull_rom_svg_path_json,
            );
            export_fn(
                napi,
                env,
                exports,
                b"discoverWin32ProcessesJson\0",
                cb_discover_win32_processes_json,
            );
            export_fn(
                napi,
                env,
                exports,
                b"projectTrajectoryJson\0",
                cb_project_trajectory_json,
            );
            export_fn(
                napi,
                env,
                exports,
                b"scanTranscriptFileJson\0",
                cb_scan_transcript_file_json,
            );
        }
    }));
    exports
}

#[cfg(test)]
mod tests {
    use super::release_native_caches_json;
    use crate::ledger_index::CACHE_TEST_LOCK;
    use serde_json::Value;

    #[test]
    fn test_release_native_caches_json_contract() {
        let _lock = CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        assert!(release_native_caches_json("invalid").is_none());

        let soft: Value =
            serde_json::from_str(&release_native_caches_json("soft").unwrap()).unwrap();
        assert_eq!(soft["released"], true);
        assert_eq!(soft["mode"], "soft");
        assert!(soft["ledgerCleared"].is_boolean());
        assert!(soft["projectCleared"].is_boolean());

        let full: Value =
            serde_json::from_str(&release_native_caches_json("full").unwrap()).unwrap();
        assert_eq!(full["released"], true);
        assert_eq!(full["mode"], "full");
        assert!(full["ledgerCleared"].is_boolean());
        assert!(full["projectCleared"].is_boolean());
    }
}
