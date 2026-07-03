declare const __TABER_ENABLE_DEBUGGER__: boolean | undefined;

export const DEBUGGER_ENABLED = typeof __TABER_ENABLE_DEBUGGER__ !== 'undefined' && __TABER_ENABLE_DEBUGGER__ === true;
