export function browserReplExecutionSources(code: string): [string, string] {
  const expression = code.trim().replace(/;\s*$/, '');
  return [
    `"use strict";\nreturn (\n${expression}\n);`,
    `"use strict";\n${code}`,
  ];
}
