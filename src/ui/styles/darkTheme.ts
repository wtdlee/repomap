export const darkTheme = {
  colors: {
    primary: '#60a5fa',
    primaryHover: '#3b82f6',
    secondary: '#94a3b8',
    success: '#22c55e',
    warning: '#f59e0b',
    error: '#ef4444',

    background: '#0f172a',
    backgroundAlt: '#1e293b',
    backgroundHover: '#334155',
    bg3: '#334155',

    border: '#334155',
    borderLight: '#475569',

    text: '#f8fafc',
    textMuted: '#94a3b8',
    textLight: '#64748b',

    accent: '#60a5fa',

    // Tag colors
    tagAuth: '#7f1d1d',
    tagAuthText: '#fca5a5',
    tagQuery: '#1e3a5f',
    tagQueryText: '#93c5fd',
    tagMutation: '#5f1e3a',
    tagMutationText: '#fda4af',
    tagRepo: '#1e293b',
    tagRepoText: '#94a3b8',
  },

  spacing: {
    xs: '4px',
    sm: '8px',
    md: '16px',
    lg: '24px',
    xl: '32px',
    xxl: '48px',
  },

  borderRadius: {
    sm: '4px',
    md: '6px',
    lg: '8px',
    xl: '12px',
    full: '9999px',
  },

  fontSize: {
    xs: '10px',
    sm: '12px',
    md: '13px',
    lg: '14px',
    xl: '16px',
    xxl: '20px',
    xxxl: '24px',
  },

  fontWeight: {
    normal: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  },

  shadow: {
    sm: '0 1px 2px rgba(0, 0, 0, 0.3)',
    md: '0 4px 6px -1px rgba(0, 0, 0, 0.4)',
    lg: '0 10px 15px -3px rgba(0, 0, 0, 0.4)',
    xl: '0 20px 25px -5px rgba(0, 0, 0, 0.4)',
  },

  transition: {
    fast: '150ms ease',
    normal: '200ms ease',
    slow: '300ms ease',
  },
} as const;

export type DarkTheme = typeof darkTheme;
