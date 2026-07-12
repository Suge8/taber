import { database } from './db.ts';

export const foregroundModeSettingKey = 'foregroundMode';

export function parseForegroundMode(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('foregroundMode must be a boolean');
  return value;
}

export async function readForegroundMode(): Promise<boolean> {
  const setting = await database.settings.get(foregroundModeSettingKey);
  return setting ? parseForegroundMode(setting.value) : false;
}

export async function setForegroundMode(value: boolean): Promise<void> {
  await database.settings.put({ key: foregroundModeSettingKey, value: parseForegroundMode(value) });
}
