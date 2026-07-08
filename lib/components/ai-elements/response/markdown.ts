export function normalizeAssistantMarkdown(value: string) {
  let result = '';
  let pendingText = '';
  let fence: '```' | '~~~' | undefined;

  for (const line of value.split(/(?<=\n)/)) {
    const marker = readFenceMarker(line);
    if (!fence && marker) {
      result += normalizeAssistantMarkdownText(pendingText) + line;
      pendingText = '';
      fence = marker;
    } else if (fence) {
      result += line;
      if (marker === fence) fence = undefined;
    } else {
      pendingText += line;
    }
  }

  return result + normalizeAssistantMarkdownText(pendingText);
}

function normalizeAssistantMarkdownText(value: string) {
  return value
    .replace(/([\p{Script=Han}A-Za-z])(\*\*[$¥€£])/gu, '$1 $2')
    .replace(/(^|[^\n])-(\*\*[\p{Script=Han}A-Za-z][^*\n：:]{0,30}\*\*)(?=-|$)/gu, '$1\n\n$2')
    .replace(/([：:。.!?？；;，,、）)\]\*`])-(?=(?:[\p{Script=Han}]|[\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9 ]{0,24}[：:]|[A-Za-z]+[\p{Script=Han}]|[A-Z][A-Za-z0-9]*(?:、|,)|`[^`\n]{1,60}`\s*[：:]))/gu, '$1\n- ');
}

function readFenceMarker(line: string): '```' | '~~~' | undefined {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('```')) return '```';
  if (trimmed.startsWith('~~~')) return '~~~';
  return undefined;
}
