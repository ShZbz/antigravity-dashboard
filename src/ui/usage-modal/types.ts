import type {
  LanguageCode,
  PreferencesSnapshot,
  ProjectConversationDetail,
  ProjectUsageOverview,
  RuntimeBridgeApi,
  UsageBucketCounts,
  UsageDayBucket,
  UsageSummarySnapshot,
  UsageUserBucket,
} from '../../contracts/index.ts';

export type UsageTab = 'overview' | 'details';
export type UsageHeatMode = 'day' | 'week';
export type UsagePeriod = 'day' | 'week' | 'month' | 'custom';
export type UsageDimension = 'model' | 'user' | 'project';
export type ModelViewMode = 'simple' | 'detailed';
export type HourlyMode = 'combined' | 'today';

export interface UsageDashboardLanguage {
  readonly language: LanguageCode;
}

export type UsageDisplayMode = 'modal' | 'fullpage';

export interface UsageDashboardOptions {
  root: ShadowRoot;
  language: UsageDashboardLanguage;
  setMarkup: (element: Element | ShadowRoot, markup: string) => void;
  displayMode?: UsageDisplayMode;
  hostLabel?: string;
  guideDismissed?: boolean;
  initialPreferences?: Partial<PreferencesSnapshot> | null;
  bridge?: Partial<RuntimeBridgeApi> | null;
  onDismissGuide: () => Promise<void>;
  onLanguage: (next: LanguageCode) => Promise<void>;
  onRefresh: () => Promise<void>;
  onPreferencesSaved?: (prefs: PreferencesSnapshot) => void;
}

export interface UsageDashboardHandle {
  readonly isOpen: boolean;
  open(data: UsageSummarySnapshot | null | undefined, trigger: Element | null): void;
  update(data: UsageSummarySnapshot | null | undefined): void;
  restoreModal(): void;
  close(): void;
  syncGuideDismissed(): void;
  syncPreferences?(prefs: PreferencesSnapshot): void;
  dispose(): void;
}

export interface UsageTotalsResult {
  from: string;
  to: string;
  models: Record<string, UsageBucketCounts>;
  modelVariants: Record<string, Record<string, UsageBucketCounts>>;
  users: Record<string, UsageUserBucket>;
  projects?: Record<string, UsageBucketCounts>;
  legacyTokens: number;
  total: number;
  requests: number;
}

export interface UsageWindow extends Window {
  __agPulseUsageGuidePreview?: boolean;
  agPulseBridge?: RuntimeBridgeApi;
  agPulseHost?: RuntimeBridgeApi;
}

export interface UsageModalState {
  value: UsageSummarySnapshot | null;
  tab: UsageTab;
  heatMode: UsageHeatMode;
  period: UsagePeriod;
  year: string | null;
  anchor: string | null;
  selected: UsageTotalsResult | null;
  disabledModels: Set<string>;
  disabledUsers: Set<string>;
  disabledProjects: Set<string>;
  dimension: UsageDimension;
  projectOverview: ProjectUsageOverview | null;
  projectOverviewKey: string;
  projectLoading: boolean;
  projectError: string | null;
  selectedProjectKey: string | null;
  projectDetail: ProjectConversationDetail | null;
  projectDetailKey: string;
  projectDetailLoading: boolean;
  projectDetailError: string | null;
  activeConvId: string | null;
  modelViewMode: ModelViewMode;
  expandedModelGroups: Set<string>;
  hourlyMode: HourlyMode;
  lastKey: string;
  busy: boolean;
  opener: HTMLElement | null;
  showAllModels: boolean;
  selectedBar: UsageTotalsResult | null;
  hourlyExpanded: boolean;
  customStart: string;
  customEnd: string;
  disposed: boolean;
  accountKey: string | null;
  currentBuckets: UsageTotalsResult[];
  guideDismissed: boolean;
  guideSaving: boolean;
  guideError: boolean;
  guideSignature: string | null;
  lastManualSig: string;
  lastAccQueryKey: string;
}

export interface UsageDomContext {
  root: ShadowRoot;
  dialog: HTMLDialogElement;
  view: ShadowRoot;
  page: HTMLElement;
  intro: HTMLElement;
  options: UsageDashboardOptions;
  state: UsageModalState;
  $: <T extends HTMLElement = HTMLElement>(id: string) => T | null;
  text: (id: string, value: string) => void;
  zh: () => boolean;
  w: (cn: string, en: string) => string;
  full: (n: number | null | undefined) => string;
  compactNum: (n: number | null | undefined) => string;
}
