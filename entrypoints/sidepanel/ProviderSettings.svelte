<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as Select from '$lib/components/ui/select/index.js';
  import ArrowClockwise from 'phosphor-svelte/lib/ArrowClockwise';
  import CaretDown from 'phosphor-svelte/lib/CaretDown';
  import Check from 'phosphor-svelte/lib/Check';
  import CheckCircle from 'phosphor-svelte/lib/CheckCircle';
  import Eye from 'phosphor-svelte/lib/Eye';
  import EyeSlash from 'phosphor-svelte/lib/EyeSlash';
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
  import { builtinProviderPresets, findPresetModel, mergeProviderCatalog, readCachedModelCatalog, refreshModelCatalog, type ProviderPreset } from '$lib/model-catalog.ts';
  import { messages, type Locale } from '$lib/sidepanel-i18n.ts';
  import CodexLoginCard from './CodexLoginCard.svelte';
  import type { Notify, ToastTone } from './toast.ts';

  type EditModelDraft = { id: number | null; name: string; contextWindowTokens: string };

  interface Props {
    locale: Locale;
    variant?: 'onboarding' | 'panel';
    onChanged?: () => void | Promise<void>;
    notify?: Notify;
  }

  let { locale, variant = 'panel', onChanged, notify }: Props = $props();
  let t = $derived(messages[locale].provider);

  let providers = $state<ProviderWithModels[]>([]);
  let providerPresets = $state<ProviderPreset[]>(builtinProviderPresets);
  let loadError = $state('');

  let draftPreset = $state(builtinProviderPresets[0].id);
  let draftName = $state(builtinProviderPresets[0].name);
  let draftBaseURL = $state(builtinProviderPresets[0].baseURL);
  let draftApiKey = $state('');
  let draftModels = $state<string[]>(builtinProviderPresets[0].models.map((model) => model.name));
  let draftModelPicker = $state('');
  let draftCustomModel = $state('');
  let draftContextWindowTokens = $state(String(builtinProviderPresets[0].models[0]?.contextWindowTokens ?? 128000));
  let customModelOpen = $state(false);
  let showApiKey = $state(false);
  let advancedOpen = $state(false);
  let saving = $state(false);
  let saveError = $state('');
  let addingProvider = $state(false);

  let refreshingCatalog = $state(false);

  let editingProviderId = $state<number | null>(null);
  let editName = $state('');
  let editBaseURL = $state('');
  let editApiKey = $state('');
  let editShowKey = $state(false);

  let editModels = $state<EditModelDraft[]>([]);
  let editModelName = $state('');
  let editModelContextWindowTokens = $state('128000');
  let testingProviderId = $state<number | null>(null);
  let confirmProviderId = $state<number | null>(null);

  const selectedPreset = $derived(providerPresets.find((provider) => provider.id === draftPreset) ?? providerPresets[0]);
  const availableDraftModels = $derived(selectedPreset.models.filter((model) => !draftModels.includes(model.name)));
  const apiProviders = $derived(providers.filter((provider) => provider.kind === 'openaiCompatible'));
  const codexProvider = $derived(providers.find((provider) => provider.kind === 'openaiCodex'));
  const codexConnected = $derived(Boolean(codexProvider?.hasCredential));
  const savedConnectionCount = $derived(apiProviders.length + (codexConnected ? 1 : 0));
  const showProviderHome = $derived(!addingProvider && editingProviderId === null);
  const showProviderList = $derived(showProviderHome && savedConnectionCount > 0);
  const showCreateForm = $derived(addingProvider);
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
      loadError = '';
      await onChanged?.();
    } catch (error) {
      loadError = describe(error);
    }
  }

  async function handleCreate() {
    saveError = '';
    const modelNames = uniqueModels(draftModels);
    if (!draftName.trim() || !draftBaseURL.trim() || modelNames.length === 0 || (variant === 'onboarding' && !draftApiKey.trim())) {
      saveError = variant === 'onboarding' ? t.onboardingRequired : t.required;
      return;
    }
    saving = true;
    try {
      await createProviderConnection({
        name: draftName.trim(),
        baseURL: draftBaseURL.trim(),
        apiKey: draftApiKey,
        models: modelNames.map((name) => ({
          name,
          contextWindowTokens: findPresetModel(providerPresets, draftPreset, name)?.contextWindowTokens ?? Number(draftContextWindowTokens),
        })),
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

  function startCreateProvider() {
    resetCreateForm();
    addingProvider = true;
  }

  function cancelCreateProvider() {
    resetCreateForm();
    addingProvider = false;
  }

  function applyPreset(id: string) {
    draftPreset = id;
    advancedOpen = id === 'custom';
    const preset = providerPresets.find((item) => item.id === id);
    if (!preset) return;
    draftName = id === 'custom' ? '' : preset.name;
    draftBaseURL = preset.baseURL;
    draftModels = presetDraftModels(preset);
    draftModelPicker = '';
    draftContextWindowTokens = String(presetDraftContextWindow(preset));
    draftCustomModel = '';
    customModelOpen = false;
  }

  function resetCreateForm() {
    const preset = providerPresets[0] ?? builtinProviderPresets[0];
    applyPreset(preset.id);
    draftApiKey = '';
    showApiKey = false;
    saveError = '';
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
    draftModels = [...draftModels, trimmed];
    const preset = findPresetModel(providerPresets, draftPreset, trimmed);
    if (preset) draftContextWindowTokens = String(preset.contextWindowTokens);
  }

  function selectDraftModel(name: string) {
    addDraftModel(name);
    draftModelPicker = '';
  }

  function removeDraftModel(name: string) {
    draftModels = draftModels.filter((model) => model !== name);
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
    addingProvider = false;
    saveError = '';
    editingProviderId = provider.id;
    editName = provider.name;
    editBaseURL = provider.baseURL;
    editApiKey = '';
    editModels = provider.models.map((model) => ({ id: model.id, name: model.name, contextWindowTokens: String(model.contextWindowTokens) }));
    editModelName = '';
    editModelContextWindowTokens = '128000';
    editShowKey = false;
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
    saveError = '';
    const modelNames = uniqueModels(editModels.map((model) => model.name));
    if (!editName.trim() || !editBaseURL.trim() || modelNames.length === 0) {
      saveError = t.required;
      return;
    }
    saving = true;
    try {
      await updateProviderConnection(provider.id, {
        name: editName,
        baseURL: editBaseURL,
        apiKey: editApiKey,
        models: editModels.map((model) => ({
          id: model.id,
          name: model.name,
          contextWindowTokens: Number(model.contextWindowTokens),
        })),
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
    saveError = '';
  }

  function addEditModel() {
    const name = editModelName.trim();
    if (!name || editModels.some((model) => model.name === name)) return;
    editModels = [...editModels, { id: null, name, contextWindowTokens: editModelContextWindowTokens || '128000' }];
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
    notify?.({ tone, text });
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
  {#if showProviderHome}
    {#if showProviderList}
      <section class="space-y-3">
        <div class="flex items-center justify-between gap-3 px-1">
          <h3 class="text-muted-foreground text-[12px] font-medium">{t.savedConnections(savedConnectionCount)}</h3>
        </div>
        {#if codexConnected}
          <CodexLoginCard {locale} provider={codexProvider} onChanged={refresh} {notify} />
        {/if}
        {#each apiProviders as provider, index (provider.id)}
          <article class="bg-surface ring-line/70 fx-enter space-y-3 rounded-2xl p-4 shadow-[0_6px_20px_oklch(0_0_0_/_0.025)] ring-1" style="--fx-index: {Math.min(index + (codexConnected ? 1 : 0), 4)}">
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

    <section class="space-y-3">
      {#if !codexConnected}
        <CodexLoginCard {locale} provider={codexProvider} onChanged={refresh} {notify} />
      {/if}
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
    <section class="fx-enter space-y-5">
      <div class="space-y-3">
        <div class="space-y-1.5"><Label class="text-xs"><IdentificationCard class="text-muted-foreground size-3.5" />{t.name}</Label><Input bind:value={editName} class="rounded-xl" /></div>
        <div class="space-y-1.5"><Label class="text-xs"><LinkSimple class="text-muted-foreground size-3.5" />{t.baseUrl}</Label><Input bind:value={editBaseURL} class="rounded-xl" /></div>
        <div class="space-y-1.5">
          <Label class="text-xs"><Key class="text-muted-foreground size-3.5" />{t.apiKey}</Label>
          <div class="relative">
            <Input type={editShowKey ? 'text' : 'password'} bind:value={editApiKey} class="rounded-xl pr-10 font-mono" />
            <button type="button" class="hover:bg-surface-2 text-muted-foreground absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-xl transition-colors" onclick={() => (editShowKey = !editShowKey)} aria-label={t.toggleKey}>{#if editShowKey}<EyeSlash class="size-4" />{:else}<Eye class="size-4" />{/if}</button>
          </div>
        </div>
      </div>

      <div class="space-y-2">
        <h5 class="text-muted-foreground flex items-center gap-1.5 text-[12px] font-medium"><Stack class="size-3.5" />{t.models}</h5>
        {#if editModels.length === 0}
          <p class="text-muted-foreground text-xs">{t.noModels}</p>
        {:else}
          <ul class="space-y-1">
            {#each editModels as model, index (model.id ?? model.name)}
              <li class="bg-surface-2/60 flex items-center justify-between gap-2 rounded-xl px-2.5 py-1.5">
                <span class="min-w-0 flex-1 truncate text-xs font-medium">{model.name}</span>
                <Input aria-label={t.contextWindow} type="number" min="1" value={model.contextWindowTokens} oninput={(event) => updateEditModelContext(index, (event.currentTarget as HTMLInputElement).value)} class="h-7 w-24 rounded-lg text-xs" />
                <Button size="icon-sm" variant="ghost" onclick={() => removeEditModel(index)} class="text-muted-foreground hover:text-danger size-7 rounded-lg" aria-label={t.removeModel}><Trash class="size-3" /></Button>
              </li>
            {/each}
          </ul>
        {/if}
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
      </div>
    </section>

    {#if saveError}<p class="text-danger fx-enter text-xs" role="alert">{saveError}</p>{/if}
    <div class="sticky bottom-0 z-10 -mx-5 -mb-5 mt-1 flex flex-wrap items-center justify-end gap-2 bg-popover/85 px-5 py-3 backdrop-blur-sm">
      <Button type="button" variant="ghost" onclick={cancelEdit} class="h-9 rounded-xl px-4">{t.cancel}</Button>
      <Button type="button" onclick={() => saveEdit(editingProvider)} disabled={saving} class="h-9 min-w-28 rounded-xl px-5 shadow-none">
        {#if saving}<ArrowClockwise class="mr-1.5 size-4 animate-spin" />{:else}<CheckCircle class="mr-1.5 size-4" weight="duotone" />{/if}{t.save}
      </Button>
    </div>
  {/if}

  {#if showCreateForm}
    <section class="fx-enter space-y-5">
      <div class="space-y-3">
        <div class="space-y-1.5">
          <Label class="text-xs" for={createProviderId}>{t.preset}</Label>
          <Select.Root type="single" bind:value={draftPreset} disabled={saving} onValueChange={applyPreset}>
            <Select.Trigger id={createProviderId} class="h-9 w-full rounded-xl bg-background px-3 text-sm shadow-[0_1px_2px_oklch(0_0_0_/_0.03)]">
              <span data-slot="select-value" class="truncate">{selectedPreset.name}</span>
            </Select.Trigger>
            <Select.Content sideOffset={8} class="rounded-2xl p-1.5 shadow-[0_18px_50px_oklch(0_0_0_/_0.12)]">
              {#each providerPresets as preset (preset.id)}
                <Select.Item value={preset.id} label={preset.name} class="rounded-xl text-xs">{preset.name}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>

        <div class="space-y-1.5">
          <Label class="text-xs" for={createApiKeyId}><Key class="text-muted-foreground size-3.5" />{t.apiKey}</Label>
          <div class="relative">
            <Input id={createApiKeyId} type={showApiKey ? 'text' : 'password'} placeholder="sk-…" bind:value={draftApiKey} disabled={saving} class="rounded-xl pr-10 font-mono" />
            <button type="button" class="hover:bg-surface-2 text-muted-foreground absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-xl transition-colors" aria-label={showApiKey ? t.hideKey : t.showKey} onclick={() => (showApiKey = !showApiKey)}>
              {#if showApiKey}<EyeSlash class="size-4" />{:else}<Eye class="size-4" />{/if}
            </button>
          </div>
        </div>
      </div>

      <div class="space-y-2">
        <Label class="text-xs" for={createModelId}><Stack class="text-muted-foreground size-3.5" />{t.modelsToAdd}</Label>
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
        {#if customModelOpen}
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
        {:else}
          <Button size="sm" variant="ghost" onclick={() => (customModelOpen = true)} class="h-7 rounded-lg px-2 text-[11.5px]"><Plus class="mr-1 size-3.5" />{t.customModel}</Button>
        {/if}
        {#if variant === 'panel'}
          <Button size="sm" variant="ghost" onclick={handleRefreshCatalog} disabled={refreshingCatalog} class="h-7 rounded-lg px-2 text-[11.5px]">
            {#if refreshingCatalog}<ArrowClockwise class="mr-1 size-3.5 animate-spin" />{:else}<ArrowClockwise class="mr-1 size-3.5" />{/if}{t.refreshCatalog}
          </Button>
        {/if}
      </div>

      <div class="space-y-2">
        <button
          type="button"
          class="text-muted-foreground hover:text-foreground flex items-center gap-1.5 rounded-lg py-1 text-[12px] transition-colors"
          aria-expanded={advancedOpen}
          aria-controls={advancedFieldsId}
          onclick={() => (advancedOpen = !advancedOpen)}
        >
          <CaretDown class="size-3.5 transition-transform {advancedOpen ? 'rotate-180' : ''}" />
          {t.advanced}
        </button>
        <div
          id={advancedFieldsId}
          class="grid transition-[grid-template-rows,opacity] duration-[var(--d-base)] ease-[var(--ease-out)] {advancedOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}"
          inert={!advancedOpen}
          aria-hidden={!advancedOpen}
        >
          <div class="min-h-0 overflow-hidden">
            <div class="mt-3 grid grid-cols-1 gap-3">
              <div class="space-y-1.5"><Label class="text-xs" for={advancedNameId}><IdentificationCard class="text-muted-foreground size-3.5" />{t.name}</Label><Input id={advancedNameId} placeholder="OpenAI" bind:value={draftName} disabled={saving} class="rounded-xl" /></div>
              <div class="space-y-1.5"><Label class="text-xs" for={advancedBaseUrlId}><LinkSimple class="text-muted-foreground size-3.5" />{t.baseUrl}</Label><Input id={advancedBaseUrlId} placeholder="https://api.openai.com/v1" bind:value={draftBaseURL} disabled={saving} class="rounded-xl" /></div>
              <div class="space-y-1.5"><Label class="text-xs" for={advancedContextId}>{t.contextWindow}</Label><Input id={advancedContextId} type="number" min="1" bind:value={draftContextWindowTokens} disabled={saving} class="rounded-xl" /></div>
            </div>
          </div>
        </div>
      </div>
    </section>

    {#if saveError}<p class="text-danger fx-enter text-xs" role="alert">{saveError}</p>{/if}
    <div class="sticky bottom-0 z-10 -mx-5 -mb-5 mt-1 flex flex-wrap items-center justify-end gap-2 bg-popover/85 px-5 py-3 backdrop-blur-sm">
      <Button type="button" variant="ghost" onclick={cancelCreateProvider} class="h-9 rounded-xl px-4">{t.cancel}</Button>
      <Button type="button" data-smoke="save-provider" onclick={handleCreate} disabled={saving} class="h-9 min-w-28 rounded-xl px-5 shadow-none">
        {#if saving}<ArrowClockwise class="mr-1.5 size-4 animate-spin" />{:else}<CheckCircle class="mr-1.5 size-4" weight="duotone" />{/if}{t.connect}
      </Button>
    </div>
  {/if}

  {#if loadError}<p class="text-danger fx-enter text-xs" role="alert">{loadError}</p>{/if}
</div>
