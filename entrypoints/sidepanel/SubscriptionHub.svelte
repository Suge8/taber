<script lang="ts">
  import CaretRight from 'phosphor-svelte/lib/CaretRight';
  import CrownSimple from 'phosphor-svelte/lib/CrownSimple';
  import {
    createChatgptAdapter,
    createXaiAdapter,
  } from '$lib/subscription-login.ts';
  import type { ProviderWithModels } from '$lib/provider-store.ts';
  import { messages, type Locale } from '$lib/sidepanel-i18n.ts';
  import GrokLogo from './GrokLogo.svelte';
  import OpenAILogo from './OpenAILogo.svelte';
  import SettingsBackButton from './SettingsBackButton.svelte';
  import SubscriptionLoginCard from './SubscriptionLoginCard.svelte';
  import type { Notify } from './toast.ts';

  interface Props {
    locale: Locale;
    codexProvider?: ProviderWithModels;
    xaiProvider?: ProviderWithModels;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    onChanged?: () => void | Promise<void>;
    notify?: Notify;
  }

  let {
    locale,
    codexProvider,
    xaiProvider,
    open = false,
    onOpenChange,
    onChanged,
    notify,
  }: Props = $props();

  let t = $derived(messages[locale].provider);
  const chatgpt = createChatgptAdapter();
  const xai = createXaiAdapter();

  const codexConnected = $derived(Boolean(codexProvider?.hasCredential));
  const xaiConnected = $derived(Boolean(xaiProvider?.hasCredential));
  const connectedCount = $derived((codexConnected ? 1 : 0) + (xaiConnected ? 1 : 0));
  const summary = $derived(
    connectedCount === 0
      ? t.subscriptionSummaryNone
      : connectedCount === 2
        ? t.subscriptionSummaryAll
        : codexConnected
          ? t.subscriptionSummaryChatgpt
          : t.subscriptionSummaryXai,
  );

  function openHub() {
    onOpenChange?.(true);
  }

  function closeHub() {
    onOpenChange?.(false);
  }
</script>

{#if open}
  <section class="space-y-3">
    <SettingsBackButton label={t.back} onclick={closeHub} />
    <div class="space-y-3">
      <SubscriptionLoginCard
        {locale}
        vendor={chatgpt}
        logo={OpenAILogo}
        provider={codexProvider}
        {onChanged}
        {notify}
      />
      <SubscriptionLoginCard
        {locale}
        vendor={xai}
        logo={GrokLogo}
        provider={xaiProvider}
        {onChanged}
        {notify}
      />
    </div>
  </section>
{:else}
  <button
    type="button"
    data-smoke="subscription-hub"
    class="group bg-surface ring-line/70 fx-enter flex w-full items-center gap-3 rounded-2xl p-4 text-left shadow-[0_8px_28px_oklch(0_0_0_/_0.03)] ring-1 transition-[background-color,transform,box-shadow] duration-150 ease-[var(--ease-out)] hover:bg-surface-2/50 hover:shadow-[0_10px_30px_oklch(0_0_0_/_0.045)] active:scale-[0.99]"
    onclick={openHub}
    style="--fx-index: 0"
  >
    <span class="bg-primary/10 text-primary grid size-10 shrink-0 place-items-center rounded-xl shadow-[inset_0_1px_0_oklch(1_0_0_/_0.45)]">
      <CrownSimple class="size-5" weight="duotone" />
    </span>
    <span class="min-w-0 flex-1 space-y-1">
      <span class="flex min-w-0 items-center gap-2">
        <span class="block min-w-0 truncate text-sm font-semibold tracking-tight text-foreground">{t.subscriptionTitle}</span>
        <span class="shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium {connectedCount > 0 ? 'bg-success/10 text-success tabular-nums' : 'bg-surface-2 text-muted-foreground'}">
          {connectedCount > 0 ? t.subscriptionConnectedCount(connectedCount) : t.apiProviderUnconfigured}
        </span>
      </span>
      <span class="text-muted-foreground block text-xs leading-relaxed text-pretty">{summary}</span>
    </span>
    <CaretRight class="text-muted-foreground group-hover:text-foreground size-4 shrink-0 transition-colors" />
  </button>
{/if}
