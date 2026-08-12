export const SYSTEM_TEST_MODE = 'SYSTEM_TEST' as const;
export const SYSTEM_TEST_LABEL = 'SYSTEM TEST - NOT A RESIDENT ALERT' as const;
export const SYSTEM_TEST_TTS_TEXT =
  'System test emergency notification' as const;
export const SYSTEM_TEST_RETENTION_DAYS = 30;

export type SystemTestMode = typeof SYSTEM_TEST_MODE;
