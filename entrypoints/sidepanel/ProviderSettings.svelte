<script lang="ts">
  import { tick } from 'svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as Select from '$lib/components/ui/select/index.js';
  import ArrowClockwise from 'phosphor-svelte/lib/ArrowClockwise';
  import CaretDown from 'phosphor-svelte/lib/CaretDown';
  import Check from 'phosphor-svelte/lib/Check';
  import CheckCircle from 'phosphor-svelte/lib/CheckCircle';
  import IdentificationCard from 'phosphor-svelte/lib/IdentificationCard';
  import Key from 'phosphor-svelte/lib/Key';
  import LinkSimple from 'phosphor-svelte/lib/LinkSimple';
  import PencilSimple from 'phosphor-svelte/lib/PencilSimple';
  import Plus from 'phosphor-svelte/lib/Plus';
  import Stack from 'phosphor-svelte/lib/Stack';
  import TestTube from 'phosphor-svelte/lib/TestTube';
  import Trash from 'phosphor-svelte/lib/Trash';
  import X from 'phosphor-svelte/lib/X';
  import {
    getProviderApiKey,
    listProvidersWithModels,
    testConnection,
    type ProviderWithModels,
  } from '$lib/provider-store.ts';
  import { createProviderConnection, deleteProviderConnection, updateProviderConnection } from '$lib/provider-config-flow.ts';
  import {
    apiKeyProviderKind,
    createOpenAIApiModelCatalogSnapshot,
    currentOpenAIApiModelCatalog,
    listOpenAIApiModelCatalog,
    modelInputFromPreset,
    selectOpenAIApiModels,
    type OpenAIApiModelCatalogSnapshot,
  } from '$lib/openai-api-provider.ts';
  import { builtinProviderPresets, findPresetModel, mergeProviderCatalog, readCachedModelCatalog, refreshModelCatalog, type ProviderPreset } from '$lib/model-catalog.ts';
  import { messages, type Locale } from '$lib/sidepanel-i18n.ts';
  import { showManualContextWindowInput } from '$lib/provider-settings-policy.ts';
  import ProviderSecretInput from './ProviderSecretInput.svelte';
  import SettingsActionBar from './SettingsActionBar.svelte';
  import SettingsBackButton from './SettingsBackButton.svelte';
  import SubscriptionHub from './SubscriptionHub.svelte';
  import type { Notify, ToastTone } from './toast.ts';

  type EditModelDraft = { id: number | null; name: string; contextWindowTokens: string };

  interface Props {
    locale: Locale;
    variant?: 'onboarding' | 'panel';
    spotlight?: boolean;
    onChanged?: () => void | Promise<void>;
    notify?: Notify;
  }

  let { locale, variant = 'panel', spotlight = false, onChanged, notify }: Props = $props();
  let t = $derived(messages[locale].provider);

  let providers = $state<ProviderWithModels[]>([]);
  let providerPresets = $state<ProviderPreset[]>(builtinProviderPresets);

  let draftPreset = $state(builtinProviderPresets[0].id);
  let draftName = $state(builtinProviderPresets[0].name);
  let draftBaseURL = $state(builtinProviderPresets[0].baseURL);
  let draftApiKey = $state('');
  let draftModels = $state<string[]>([]);
  let draftModelPicker = $state('');
  let draftCustomModel = $state('');
  let draftContextWindowTokens = $state(String(builtinProviderPresets[0].models[0]?.contextWindowTokens ?? 128000));
  let customModelOpen = $state(false);
  let showApiKey = $state(false);
  let advancedOpen = $state(false);
  let saving = $state(false);
  let addingProvider = $state(false);
  let subscriptionsOpen = $state(false);

  let refreshingCatalog = $state(false);
  let loadingDraftModels = $state(false);
  let draftAccountModels = $state<OpenAIApiModelCatalogSnapshot | null>(null);

  let editingProviderId = $state<number | null>(null);
  let editName = $state('');
  let editBaseURL = $state('');
  let editApiKey = $state('');
  let editShowKey = $state(false);

  let editModels = $state<EditModelDraft[]>([]);
  let editModelName = $state('');
  let editModelContextWindowTokens = $state('128000');
  let loadingEditModels = $state(false);
  let editAccountModels = $state<OpenAIApiModelCatalogSnapshot | null>(null);
  let testingProviderId = $state<number | null>(null);
  let confirmProviderId = $state<number | null>(null);
  let createActionBarElement = $state<HTMLDivElement | null>(null);

  const selectedPreset = $derived(providerPresets.find((provider) => provider.id === draftPreset) ?? providerPresets[0]);
  const draftKind = $derived(apiKeyProviderKind(draftBaseURL));
  const currentDraftAccountModels = $derived(currentOpenAIApiModelCatalog(draftAccountModels, { baseURL: draftBaseURL, apiKey: draftApiKey }));
  const canLoadDraftAccountModels = $derived(Boolean(draftApiKey.trim() && draftBaseURL.trim()));
  const showDraftModelSection = $derived(draftKind === 'openaiApiKey' ? canLoadDraftAccountModels || Boolean(currentDraftAccountModels) : Boolean(draftBaseURL.trim()));
  const showDraftModelControls = $derived(Boolean(draftBaseURL.trim()) && (draftKind !== 'openaiApiKey' || Boolean(currentDraftAccountModels)));
  const draftModelSource = $derived(draftKind === 'openaiApiKey' ? currentDraftAccountModels : selectedPreset);
  const availableDraftModels = $derived((draftModelSource?.models ?? []).filter((model) => !draftModels.includes(model.name)));
  const editKind = $derived(apiKeyProviderKind(editBaseURL));
  const showDraftContextWindowInput = $derived(showManualContextWindowInput(draftKind));
  const showEditContextWindowInput = $derived(showManualContextWindowInput(editKind));
  const currentEditAccountModels = $derived(currentOpenAIApiModelCatalog(editAccountModels, { baseURL: editBaseURL, apiKey: editApiKey }));
  const canLoadEditAccountModels = $derived(Boolean(editApiKey.trim() && editBaseURL.trim()));
  const availableEditModels = $derived((editKind === 'openaiApiKey' ? currentEditAccountModels?.models ?? [] : []).filter((model) => !editModels.some((draft) => draft.name === model.name)));
  const apiProviders = $derived(providers.filter((provider) => provider.kind !== 'openaiCodex' && provider.kind !== 'xaiSub'));
  const codexProvider = $derived(providers.find((provider) => provider.kind === 'openaiCodex'));
  const xaiProvider = $derived(providers.find((provider) => provider.kind === 'xaiSub'));
  const savedConnectionCount = $derived(apiProviders.length);
  const showProviderHome = $derived(!addingProvider && editingProviderId === null && !subscriptionsOpen);
  const showProviderList = $derived(showProviderHome && savedConnectionCount > 0);
  const showCreateForm = $derived(addingProvider);
  const showSubscriptions = $derived(subscriptionsOpen && !addingProvider && editingProviderId === null);
  const editingProvider = $derived(apiProviders.find((provider) => provider.id === editingProviderId));
  const createProviderId = $derived(variant === 'onboarding' ? 'onboarding-provider' : 'provider-preset');
  const createModelId = $derived(variant === 'onboarding' ? 'onboarding-model' : 'provider-model');
  const createApiKeyId = $derived(variant === 'onboarding' ? 'onboarding-api-key' : 'provider-api-key');
  const advancedNameId = $derived(variant === 'onboarding' ? 'onboarding-provider-name' : 'provider-name');
  const advancedBaseUrlId = $derived(variant === 'onboarding' ? 'onboarding-provider-base-url' : 'provider-base-url');
  const advancedContextId = $derived(variant === 'onboarding' ? 'onboarding-provider-context-window' : 'provider-context-window');
  const advancedFieldsId = $derived(variant === 'onboarding' ? 'onboarding-provider-advanced' : 'provider-advanced');

  $effect(() => {
    void refresh();
  });

  async function refresh() {
    try {
      const [list, catalog] = await Promise.all([listProvidersWithModels(), readCachedModelCatalog()]);
      providerPresets = mergeProviderCatalog(catalog);
      providers = list;
      await onChanged?.();
    } catch (error) {
      pushError(error);
    }
  }

  async function handleCreate() {
    const modelNames = uniqueModels(draftModels);
    const kind = apiKeyProviderKind(draftBaseURL);
    if (!draftName.trim() || !draftBaseURL.trim() || modelNames.length === 0 || ((variant === 'onboarding' || kind === 'openaiApiKey') && !draftApiKey.trim())) {
      pushNotice('error', variant === 'onboarding' ? t.onboardingRequired : t.required);
      return;
    }
    saving = true;
    try {
      await createProviderConnection({
        kind,
        name: draftName.trim(),
        baseURL: draftBaseURL.trim(),
        apiKey: draftApiKey,
        models: kind === 'openaiApiKey'
          ? selectOpenAIApiModels(requireDraftAccountModels(), modelNames)
          : modelNames.map((name) => {
              const model = modelInputFromPreset(name, selectedPreset);
              return findPresetModel(providerPresets, draftPreset, name) ? model : { ...model, contextWindowTokens: Number(draftContextWindowTokens) };
            }),
      });
      resetCreateForm();
      addingProvider = false;
      await refresh();
      pushNotice('success', t.saved);
    } catch (error) {
      pushError(error);
    } finally {
      saving = false;
    }
  }

  async function handleRefreshCatalog() {
    refreshingCatalog = true;
    try {
      const catalog = await refreshModelCatalog();
      providerPresets = mergeProviderCatalog(catalog);
      pushNotice('success', t.catalogUpdated);
    } catch (error) {
      pushError(error);
    } finally {
      refreshingCatalog = false;
    }
  }

  async function loadDraftAccountModels() {
    if (!draftApiKey.trim() || !draftBaseURL.trim()) {
      pushNotice('error', t.openAIModelsKeyRequired);
      return;
    }
    const request = { baseURL: draftBaseURL.trim(), apiKey: draftApiKey.trim() };
    loadingDraftModels = true;
    try {
      const catalog = await listOpenAIApiModelCatalog(request);
      const snapshot = createOpenAIApiModelCatalogSnapshot(request, catalog);
      draftAccountModels = snapshot;
      if (!currentOpenAIApiModelCatalog(snapshot, { baseURL: draftBaseURL, apiKey: draftApiKey })) return;
      draftModels = draftModels.filter((name) => catalog.models.some((model) => model.name === name));
      if (draftModels.length === 0 && catalog.models[0]) draftModels = [catalog.models[0].name];
      pushNotice('success', t.okModels(catalog.models.length));
    } catch (error) {
      pushError(error);
    } finally {
      loadingDraftModels = false;
    }
  }

  async function loadEditAccountModels() {
    if (!editApiKey.trim() || !editBaseURL.trim()) {
      pushNotice('error', t.openAIModelsKeyRequired);
      return;
    }
    const request = { baseURL: editBaseURL.trim(), apiKey: editApiKey.trim() };
    loadingEditModels = true;
    try {
      const catalog = await listOpenAIApiModelCatalog(request);
      const snapshot = createOpenAIApiModelCatalogSnapshot(request, catalog);
      editAccountModels = snapshot;
      if (!currentOpenAIApiModelCatalog(snapshot, { baseURL: editBaseURL, apiKey: editApiKey })) return;
      editModels = editModels.filter((draft) => catalog.models.some((model) => model.name === draft.name));
      pushNotice('success', t.okModels(catalog.models.length));
    } catch (error) {
      pushError(error);
    } finally {
      loadingEditModels = false;
    }
  }

  function requireDraftAccountModels() {
    if (!currentDraftAccountModels) throw new Error(t.openAIModelsLoadRequired);
    return currentDraftAccountModels;
  }

  function requireEditAccountModels() {
    if (!currentEditAccountModels) throw new Error(t.openAIModelsLoadRequired);
    return currentEditAccountModels;
  }

  function startCreateProvider() {
    subscriptionsOpen = false;
    resetCreateForm();
    addingProvider = true;
  }

  function cancelCreateProvider() {
    resetCreateForm();
    addingProvider = false;
  }

  async function toggleAdvanced() {
    const previousBox = createActionBarElement?.getBoundingClientRect();
    advancedOpen = !advancedOpen;
    await tick();
    animateFrom(previousBox, createActionBarElement);
  }

  function animateFrom(previousBox: DOMRect | undefined, element: HTMLElement | null) {
    if (!previousBox || !element || shouldReduceMotion()) return;
    const nextBox = element.getBoundingClientRect();
    const deltaX = previousBox.left - nextBox.left;
    const deltaY = previousBox.top - nextBox.top;
    if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return;
    const timing = animationTiming();
    element.animate(
      [
        { transform: `translate(${deltaX}px, ${deltaY}px)` },
        { transform: 'translate(0, 0)' },
      ],
      timing,
    );
  }

  function animationTiming() {
    if (typeof window === 'undefined') return { duration: 180, easing: 'ease-out' };
    const styles = getComputedStyle(document.documentElement);
    return {
      duration: durationMs(styles.getPropertyValue('--d-base'), 180),
      easing: styles.getPropertyValue('--ease-out').trim() || 'ease-out',
    };
  }

  function durationMs(value: string, fallback: number) {
    const trimmed = value.trim();
    if (trimmed.endsWith('ms')) return Number(trimmed.slice(0, -2)) || fallback;
    if (trimmed.endsWith('s')) return (Number(trimmed.slice(0, -1)) || fallback / 1000) * 1000;
    return fallback;
  }

  function shouldReduceMotion() {
    return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function applyPreset(id: string) {
    draftPreset = id;
    advancedOpen = id === 'custom';
    const preset = providerPresets.find((item) => item.id === id);
    if (!preset) return;
    draftName = id === 'custom' ? '' : preset.name;
    draftBaseURL = preset.baseURL;
    draftAccountModels = null;
    draftModels = apiKeyProviderKind(preset.baseURL) === 'openaiApiKey' ? [] : presetDraftModels(preset);
    draftModelPicker = '';
    draftContextWindowTokens = String(presetDraftContextWindow(preset));
    draftCustomModel = '';
    customModelOpen = false;
  }

  function resetCreateForm() {
    const preset = providerPresets[0] ?? builtinProviderPresets[0];
    applyPreset(preset.id);
    draftApiKey = '';
    draftAccountModels = null;
    showApiKey = false;
  }

  function presetDraftModels(preset: ProviderPreset) {
    const source = builtinProviderPresets.find((item) => item.id === preset.id) ?? preset;
    return source.models.map((model) => model.name);
  }

  function presetDraftContextWindow(preset: ProviderPreset) {
    const source = builtinProviderPresets.find((item) => item.id === preset.id) ?? preset;
    return source.models[0]?.contextWindowTokens ?? 128000;
  }

  function addDraftModel(name: string) {
    const trimmed = name.trim();
    if (!trimmed || draftModels.includes(trimmed)) return;
    if (draftKind === 'openaiApiKey' && !currentDraftAccountModels?.models.some((model) => model.name === trimmed)) {
      pushNotice('error', t.openAIModelUnavailable);
      return;
    }
    draftModels = [...draftModels, trimmed];
    const preset = findPresetModel(draftKind === 'openaiApiKey' && currentDraftAccountModels ? [currentDraftAccountModels] : providerPresets, draftPreset, trimmed);
    if (preset) draftContextWindowTokens = String(preset.contextWindowTokens);
  }

  function selectDraftModel(name: string) {
    addDraftModel(name);
    draftModelPicker = '';
  }

  function removeDraftModel(name: string) {
    draftModels = draftModels.filter((model) => model !== name);
  }

  function selectEditModel(name: string) {
    const model = currentEditAccountModels?.models.find((item) => item.name === name);
    if (!model || editModels.some((draft) => draft.name === model.name)) return;
    editModels = [...editModels, { id: null, name: model.name, contextWindowTokens: String(model.contextWindowTokens) }];
    editModelName = '';
  }

  function addCustomDraftModel() {
    const name = draftCustomModel.trim();
    if (!name) return;
    addDraftModel(name);
    draftCustomModel = '';
    customModelOpen = false;
  }

  function cancelCustomDraftModel() {
    draftCustomModel = '';
    customModelOpen = false;
  }

  async function startEdit(provider: ProviderWithModels) {
    subscriptionsOpen = false;
    addingProvider = false;
    editingProviderId = provider.id;
    editName = provider.name;
    editBaseURL = provider.baseURL;
    editApiKey = '';
    editModels = provider.models.map((model) => ({ id: model.id, name: model.name, contextWindowTokens: String(model.contextWindowTokens) }));
    editModelName = '';
    editModelContextWindowTokens = '128000';
    editShowKey = false;
    editAccountModels = null;
    try {
      editApiKey = await getProviderApiKey(provider.id);
    } catch (error) {
      pushError(error);
    }
  }

  function cancelEdit() {
    resetEditForm();
  }

  async function saveEdit(provider: ProviderWithModels) {
    const modelNames = uniqueModels(editModels.map((model) => model.name));
    const kind = apiKeyProviderKind(editBaseURL);
    if (!editName.trim() || !editBaseURL.trim() || modelNames.length === 0 || (kind === 'openaiApiKey' && !editApiKey.trim())) {
      pushNotice('error', t.required);
      return;
    }
    saving = true;
    try {
      const models = kind === 'openaiApiKey'
        ? selectOpenAIApiModels(requireEditAccountModels(), modelNames)
          .map((model) => ({ ...model, id: editModels.find((draft) => draft.name === model.name)?.id ?? null }))
        : editModels.map((model) => ({
            id: model.id,
            name: model.name,
            contextWindowTokens: Number(model.contextWindowTokens),
          }));
      await updateProviderConnection(provider.id, {
        kind,
        name: editName,
        baseURL: editBaseURL,
        apiKey: editApiKey,
        models,
      });
      resetEditForm();
      await refresh();
      pushNotice('success', t.saved);
    } catch (error) {
      pushError(error);
    } finally {
      saving = false;
    }
  }

  function resetEditForm() {
    editingProviderId = null;
    editModels = [];
    editModelName = '';
    editModelContextWindowTokens = '128000';
  }

  function addEditModel() {
    const name = editModelName.trim();
    if (!name || editModels.some((model) => model.name === name)) return;
    if (editKind === 'openaiApiKey') {
      const model = currentEditAccountModels?.models.find((item) => item.name === name);
      if (!model) {
        pushNotice('error', t.openAIModelUnavailable);
        return;
      }
      editModels = [...editModels, { id: null, name, contextWindowTokens: String(model.contextWindowTokens) }];
    } else {
      editModels = [...editModels, { id: null, name, contextWindowTokens: editModelContextWindowTokens || '128000' }];
    }
    editModelName = '';
    editModelContextWindowTokens = '128000';
  }

  function removeEditModel(index: number) {
    editModels = editModels.filter((_, modelIndex) => modelIndex !== index);
  }

  function updateEditModelContext(index: number, value: string) {
    editModels = editModels.map((model, modelIndex) => modelIndex === index ? { ...model, contextWindowTokens: value } : model);
  }

  async function requestRemoveProvider(id: number) {
    if (confirmProviderId !== id) {
      confirmProviderId = id;
      window.setTimeout(() => { if (confirmProviderId === id) confirmProviderId = null; }, 3000);
      return;
    }
    try {
      await deleteProviderConnection(id);
      confirmProviderId = null;
      await refresh();
    } catch (error) {
      pushError(error);
    }
  }

  async function testExisting(provider: ProviderWithModels) {
    testingProviderId = provider.id;
    const baseURL = provider.baseURL;
    try {
      const result = await testConnection(baseURL, await getProviderApiKey(provider.id));
      const text = result.ok
        ? (result.modelIds?.length ? t.okModels(result.modelIds.length) : t.okEndpoint)
        : result.error;
      pushNotice(result.ok ? 'success' : 'error', text);
    } catch (error) {
      pushError(error);
    } finally {
      testingProviderId = null;
    }
  }

  function pushNotice(tone: ToastTone, text: string) {
    notify?.({ tone, icon: 'model', text });
  }

  function pushError(error: unknown) {
    pushNotice('error', describe(error));
  }

  function uniqueModels(names: string[]) {
    return [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  }

  function describe(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
</script>

<div class="flex flex-col gap-5">
  {#if showSubscriptions}
    <SubscriptionHub
      {locale}
      {codexProvider}
      {xaiProvider}
      open={true}
      onOpenChange={(next) => {
        subscriptionsOpen = next;
      }}
      onChanged={refresh}
      {notify}
    />
  {/if}

  {#if showProviderHome}
    {#if showProviderList}
      <section class="space-y-3">
        <div class="flex items-center justify-between gap-3 px-1">
          <h3 class="text-muted-foreground text-[12px] font-medium">{t.savedConnections(savedConnectionCount)}</h3>
        </div>
        {#each apiProviders as provider, index (provider.id)}
          <article class="bg-surface ring-line/70 fx-enter space-y-3 rounded-2xl p-4 shadow-[0_6px_20px_oklch(0_0_0_/_0.025)] ring-1" style="--fx-index: {Math.min(index, 4)}">
            <header class="fx-enter flex items-center justify-between gap-3">
              <div class="min-w-0">
                <h4 class="truncate text-sm font-semibold tracking-tight">{provider.name}</h4>
              </div>
              <div class="flex shrink-0 gap-1">
                <Button size="icon-sm" variant="ghost" onclick={() => testExisting(provider)} disabled={testingProviderId === provider.id} class="size-7 rounded-lg" aria-label={t.test}>
                  {#if testingProviderId === provider.id}<ArrowClockwise class="size-3.5 animate-spin" />{:else}<TestTube class="size-3.5" />{/if}
                </Button>
                <Button size="icon-sm" variant="ghost" onclick={() => void startEdit(provider)} class="size-7 rounded-lg" aria-label={t.edit}><PencilSimple class="size-3.5" /></Button>
                <Button size="sm" variant="ghost" onclick={() => void requestRemoveProvider(provider.id)} class="text-danger hover:text-danger h-7 rounded-lg px-2 text-[11.5px]" aria-label={t.confirmDelete}>
                  {#if confirmProviderId === provider.id}{t.confirmDelete}{:else}<Trash class="size-3.5" />{/if}
                </Button>
              </div>
            </header>

            <div class="space-y-2">
              <h5 class="text-muted-foreground flex items-center gap-1.5 text-[12px] font-medium"><Stack class="size-3.5" />{t.models}</h5>
              {#if provider.models.length === 0}
                <p class="text-muted-foreground text-xs">{t.noModels}</p>
              {:else}
                <div class="flex flex-wrap gap-1.5">
                  {#each provider.models as model (model.id)}
                    <span class="bg-surface-2/70 text-foreground ring-line/60 inline-flex max-w-full items-center rounded-xl px-2.5 py-1 text-[12px] ring-1">
                      <span class="truncate">{model.name}</span>
                    </span>
                  {/each}
                </div>
              {/if}
            </div>
          </article>
        {/each}
      </section>
    {/if}

    <section class="space-y-3 {spotlight ? 'fx-spotlight fx-spotlight-frame' : ''}">
      <SubscriptionHub
        {locale}
        {codexProvider}
        {xaiProvider}
        open={false}
        onOpenChange={(next) => {
          subscriptionsOpen = next;
        }}
        onChanged={refresh}
        {notify}
      />
      <button
        type="button"
        data-smoke="add-api-provider"
        class="group bg-surface ring-line/70 fx-enter flex w-full items-center gap-3 rounded-2xl p-4 text-left shadow-[0_8px_28px_oklch(0_0_0_/_0.03)] ring-1 transition-[background-color,transform,box-shadow] duration-150 ease-[var(--ease-out)] hover:bg-surface-2/50 hover:shadow-[0_10px_30px_oklch(0_0_0_/_0.045)] active:scale-[0.99]"
        onclick={startCreateProvider}
      >
        <span class="bg-surface-2 text-foreground grid size-10 shrink-0 place-items-center rounded-xl shadow-[inset_0_1px_0_oklch(1_0_0_/_0.45)]">
          <Key class="size-5" weight="duotone" />
        </span>
        <span class="min-w-0 flex-1 space-y-1">
          <span class="flex min-w-0 items-center gap-2">
            <span class="block min-w-0 truncate text-sm font-semibold tracking-tight text-foreground">{t.apiProviderTitle}</span>
            <span class="bg-surface-2 text-muted-foreground shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium">{t.apiProviderUnconfigured}</span>
          </span>
          <span class="text-muted-foreground block text-xs leading-relaxed text-pretty">{t.apiProviderDescription}</span>
        </span>
        <Plus class="text-muted-foreground group-hover:text-foreground size-4 shrink-0 transition-colors duration-150 ease-[var(--ease-out)]" />
      </button>
    </section>
  {/if}

  {#if editingProvider}
    <section class="provider-settings-page">
      <SettingsBackButton label={t.back} onclick={cancelEdit} />
      <section class="provider-settings-form fx-enter">
      <div class="space-y-3">
        <div class="space-y-1.5"><Label class="text-xs"><IdentificationCard class="text-muted-foreground size-3.5" />{t.name}</Label><Input bind:value={editName} class="rounded-xl" /></div>
        <div class="space-y-1.5"><Label class="text-xs"><LinkSimple class="text-muted-foreground size-3.5" />{t.baseUrl}</Label><Input bind:value={editBaseURL} class="rounded-xl" /></div>
        <ProviderSecretInput
          bind:value={editApiKey}
          bind:visible={editShowKey}
          placeholder={t.keyLabel}
          showLabel={t.showKey}
          hideLabel={t.hideKey}
          ariaLabel={t.apiKey}
        />
      </div>

      <div class="space-y-2">
        <div class="flex items-center justify-between gap-2">
          <h5 class="text-muted-foreground flex items-center gap-1.5 text-[12px] font-medium"><Stack class="size-3.5" />{t.models}</h5>
          {#if editKind === 'openaiApiKey' && canLoadEditAccountModels}
            <Button size="icon-sm" variant="ghost" onclick={() => void loadEditAccountModels()} disabled={loadingEditModels} class="text-muted-foreground hover:text-foreground size-7 rounded-lg" aria-label={t.openAIModelsLoad} title={t.openAIModelsLoad}>
              <ArrowClockwise class="size-3.5 {loadingEditModels ? 'animate-spin' : ''}" />
            </Button>
          {/if}
        </div>
        {#if editModels.length === 0}
          <p class="text-muted-foreground text-xs">{t.noModels}</p>
        {:else}
          <ul class="space-y-1">
            {#each editModels as model, index (model.id ?? model.name)}
              <li class="bg-surface-2/60 flex items-center justify-between gap-2 rounded-xl px-2.5 py-1.5">
                <span class="min-w-0 flex-1 truncate text-xs font-medium">{model.name}</span>
                {#if showEditContextWindowInput}
                  <Input aria-label={t.contextWindow} type="number" min="1" value={model.contextWindowTokens} oninput={(event) => updateEditModelContext(index, (event.currentTarget as HTMLInputElement).value)} class="h-7 w-24 rounded-lg text-xs" />
                {/if}
                <Button size="icon-sm" variant="ghost" onclick={() => removeEditModel(index)} class="text-muted-foreground hover:text-danger size-7 rounded-lg" aria-label={t.removeModel}><Trash class="size-3" /></Button>
              </li>
            {/each}
          </ul>
        {/if}
        {#if editKind === 'openaiApiKey'}
          {#if availableEditModels.length > 0}
            <Select.Root type="single" value="" disabled={saving} onValueChange={selectEditModel}>
              <Select.Trigger class="h-8 min-w-40 rounded-xl bg-background px-3 text-xs"><span data-slot="select-value" class="truncate text-muted-foreground">{t.addModel}</span></Select.Trigger>
              <Select.Content sideOffset={8} class="rounded-2xl p-1.5 shadow-[0_18px_50px_oklch(0_0_0_/_0.12)]">
                {#each availableEditModels as model (model.name)}<Select.Item value={model.name} label={model.name} class="rounded-xl text-xs">{model.name}</Select.Item>{/each}
              </Select.Content>
            </Select.Root>
          {/if}
        {:else}
          <div class="grid grid-cols-[1fr_7rem_auto] gap-2 pt-1">
            <Input
              placeholder={t.modelPlaceholder}
              bind:value={editModelName}
              onkeydown={(event) => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); addEditModel(); } }}
              class="h-8 rounded-xl text-xs"
            />
            <Input aria-label={t.contextWindow} type="number" min="1" bind:value={editModelContextWindowTokens} class="h-8 rounded-xl text-xs" />
            <Button size="icon-sm" onclick={addEditModel} disabled={!editModelName.trim()} class="size-8 rounded-xl" aria-label={t.add}><Plus class="size-3.5" /></Button>
          </div>
        {/if}
      </div>
      <SettingsActionBar>
        <Button type="button" onclick={() => saveEdit(editingProvider)} disabled={saving} class="h-9 min-w-28 rounded-xl px-5 shadow-none">
          {#if saving}<ArrowClockwise class="mr-1.5 size-4 animate-spin" />{:else}<CheckCircle class="mr-1.5 size-4" weight="duotone" />{/if}{t.save}
        </Button>
      </SettingsActionBar>
      </section>
    </section>
  {/if}

  {#if showCreateForm}
    <section class="provider-settings-page">
      <SettingsBackButton label={t.back} onclick={cancelCreateProvider} />
      <section class="provider-settings-form fx-enter">
      <div class="space-y-3">
        <Select.Root type="single" bind:value={draftPreset} disabled={saving} onValueChange={applyPreset}>
          <Select.Trigger id={createProviderId} aria-label={t.preset} class="h-9 w-full rounded-xl bg-background px-3 text-sm shadow-[0_1px_2px_oklch(0_0_0_/_0.03)]">
              <span data-slot="select-value" class="truncate">{selectedPreset.name}</span>
            </Select.Trigger>
            <Select.Content sideOffset={8} class="rounded-2xl p-1.5 shadow-[0_18px_50px_oklch(0_0_0_/_0.12)]">
            {#each providerPresets as preset (preset.id)}
              <Select.Item value={preset.id} label={preset.name} class="rounded-xl text-xs">{preset.name}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>

        <ProviderSecretInput
          id={createApiKeyId}
          bind:value={draftApiKey}
          bind:visible={showApiKey}
          disabled={saving}
          placeholder={t.keyLabel}
          showLabel={t.showKey}
          hideLabel={t.hideKey}
          ariaLabel={t.apiKey}
        />
      </div>

      {#if showDraftModelSection}
        <div class="space-y-2">
          <div class="flex items-center justify-between gap-2">
            <Label class="text-xs" for={createModelId}><Stack class="text-muted-foreground size-3.5" />{t.modelsToAdd}</Label>
            {#if draftKind === 'openaiApiKey' && canLoadDraftAccountModels}
              <Button size="icon-sm" variant="ghost" onclick={() => void loadDraftAccountModels()} disabled={loadingDraftModels} class="text-muted-foreground hover:text-foreground size-7 rounded-lg" aria-label={t.openAIModelsLoad} title={t.openAIModelsLoad}>
                <ArrowClockwise class="size-3.5 {loadingDraftModels ? 'animate-spin' : ''}" />
              </Button>
            {/if}
          </div>
          {#if showDraftModelControls}
          {#if availableDraftModels.length > 0}
            <Select.Root type="single" bind:value={draftModelPicker} disabled={saving} onValueChange={selectDraftModel}>
              <Select.Trigger id={createModelId} class="h-9 w-full rounded-xl bg-background px-3 text-sm">
                <span data-slot="select-value" class="truncate text-muted-foreground">{t.addModel}</span>
              </Select.Trigger>
              <Select.Content sideOffset={8} class="rounded-2xl p-1.5 shadow-[0_18px_50px_oklch(0_0_0_/_0.12)]">
                {#each availableDraftModels as model (model.name)}
                  <Select.Item value={model.name} label={model.name} class="rounded-xl text-xs">{model.name}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          {/if}
          <div class="flex flex-wrap gap-1.5">
            {#each draftModels as model (model)}
              <span class="group bg-surface-2/70 text-foreground ring-line/60 inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1 text-[12px] ring-1">
                {model}
                <button type="button" class="text-muted-foreground hover:text-danger opacity-70 transition-opacity group-hover:opacity-100" aria-label={t.removeModel} onclick={() => removeDraftModel(model)}>
                  <X class="size-3" />
                </button>
              </span>
            {/each}
            {#if draftModels.length === 0}<span class="text-muted-foreground px-0.5 py-1 text-xs">{t.noSelectedModels}</span>{/if}
          </div>
          {#if draftKind !== 'openaiApiKey' && customModelOpen}
            <div class="grid grid-cols-[1fr_auto_auto] gap-2">
              <Input
                aria-label={t.customModel}
                placeholder={t.customModelPlaceholder}
                bind:value={draftCustomModel}
                disabled={saving}
                class="h-9 rounded-xl text-sm"
                onkeydown={(event) => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); addCustomDraftModel(); } }}
              />
              <Button size="icon-sm" onclick={addCustomDraftModel} disabled={saving || !draftCustomModel.trim()} class="size-9 rounded-xl" aria-label={t.add}><Check class="size-3.5" /></Button>
              <Button size="icon-sm" variant="ghost" onclick={cancelCustomDraftModel} class="size-9 rounded-xl" aria-label={t.cancel}><X class="size-3.5" /></Button>
            </div>
          {:else if draftKind !== 'openaiApiKey'}
            <Button size="sm" variant="ghost" onclick={() => (customModelOpen = true)} class="h-7 rounded-lg px-2 text-[11.5px]"><Plus class="mr-1 size-3.5" />{t.customModel}</Button>
          {/if}
          {#if variant === 'panel' && draftKind !== 'openaiApiKey'}
            <Button size="sm" variant="ghost" onclick={handleRefreshCatalog} disabled={refreshingCatalog} class="h-7 rounded-lg px-2 text-[11.5px]">
              {#if refreshingCatalog}<ArrowClockwise class="mr-1 size-3.5 animate-spin" />{:else}<ArrowClockwise class="mr-1 size-3.5" />{/if}{t.refreshCatalog}
            </Button>
          {/if}
          {/if}
        </div>
      {/if}

      <div class="provider-settings-advanced" data-open={advancedOpen ? '' : undefined}>
        <button
          type="button"
          class="provider-settings-advanced__toggle text-muted-foreground hover:text-foreground flex items-center gap-1.5 rounded-lg py-1 text-[12px] transition-colors"
          aria-expanded={advancedOpen}
          aria-controls={advancedFieldsId}
          onclick={() => void toggleAdvanced()}
        >
          <CaretDown class="size-3.5 transition-transform {advancedOpen ? 'rotate-180' : ''}" />
          {t.advanced}
        </button>
        <div
          id={advancedFieldsId}
          class="provider-settings-advanced__fields grid transition-[grid-template-rows,opacity] duration-[var(--d-base)] ease-[var(--ease-out)] {advancedOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}"
          inert={!advancedOpen}
          aria-hidden={!advancedOpen}
        >
          <div class="min-h-0 overflow-hidden">
            <div class="mt-3 grid grid-cols-1 gap-3">
              <div class="space-y-1.5"><Label class="text-xs" for={advancedNameId}><IdentificationCard class="text-muted-foreground size-3.5" />{t.name}</Label><Input id={advancedNameId} placeholder="OpenAI" bind:value={draftName} disabled={saving} class="rounded-xl" /></div>
              <div class="space-y-1.5"><Label class="text-xs" for={advancedBaseUrlId}><LinkSimple class="text-muted-foreground size-3.5" />{t.baseUrl}</Label><Input id={advancedBaseUrlId} placeholder="https://api.openai.com/v1" bind:value={draftBaseURL} disabled={saving} class="rounded-xl" /></div>
              {#if showDraftContextWindowInput}
                <div class="space-y-1.5"><Label class="text-xs" for={advancedContextId}>{t.contextWindow}</Label><Input id={advancedContextId} type="number" min="1" bind:value={draftContextWindowTokens} disabled={saving} class="rounded-xl" /></div>
              {/if}
            </div>
          </div>
        </div>
        <SettingsActionBar bind:ref={createActionBarElement}>
          <Button type="button" data-smoke="save-provider" onclick={handleCreate} disabled={saving} class="h-9 min-w-28 rounded-xl px-5 shadow-none">
            {#if saving}<ArrowClockwise class="mr-1.5 size-4 animate-spin" />{:else}<CheckCircle class="mr-1.5 size-4" weight="duotone" />{/if}{t.connect}
          </Button>
        </SettingsActionBar>
      </div>
      </section>
    </section>
  {/if}

</div>

<style>
  .provider-settings-page {
    --provider-settings-back-gap: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: var(--provider-settings-back-gap);
  }

  .provider-settings-form {
    --provider-settings-section-gap: 1rem;
    --provider-settings-action-gap: 0.875rem;
    display: flex;
    flex-direction: column;
    gap: var(--provider-settings-section-gap);
  }

  .provider-settings-advanced {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    column-gap: var(--provider-settings-section-gap);
  }

  .provider-settings-advanced__toggle {
    grid-column: 1;
    grid-row: 1;
    justify-self: start;
  }

  .provider-settings-advanced__fields {
    grid-column: 1 / -1;
    grid-row: 2;
  }

  .provider-settings-advanced :global(.settings-action-bar) {
    grid-column: 2;
    grid-row: 1;
  }

  .provider-settings-advanced[data-open] :global(.settings-action-bar) {
    grid-column: 1 / -1;
    grid-row: 3;
    margin-top: var(--provider-settings-action-gap);
  }
</style>
