import { css } from '../setup.js';
import { theme } from './theme.js';

export const globalStyles = css`
  :global {
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    html,
    body {
      font-family:
        -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: ${theme.fontSize.md};
      line-height: 1.6;
      color: ${theme.colors.text};
      background: ${theme.colors.background};
      -webkit-font-smoothing: antialiased;
    }

    a {
      color: ${theme.colors.primary};
      text-decoration: none;

      &:hover {
        text-decoration: underline;
      }
    }

    code {
      font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
      font-size: ${theme.fontSize.sm};
      background: ${theme.colors.backgroundAlt};
      padding: 2px 6px;
      border-radius: ${theme.borderRadius.sm};
    }

    pre {
      font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
      font-size: ${theme.fontSize.sm};
      background: ${theme.colors.codeBackground};
      color: ${theme.colors.codeText};
      padding: ${theme.spacing.md};
      border-radius: ${theme.borderRadius.md};
      overflow-x: auto;

      code {
        background: none;
        padding: 0;
      }
    }

    h1,
    h2,
    h3,
    h4,
    h5,
    h6 {
      font-weight: ${theme.fontWeight.semibold};
      line-height: 1.3;
      margin-bottom: ${theme.spacing.sm};
    }

    h1 {
      font-size: ${theme.fontSize.xxxl};
    }
    h2 {
      font-size: ${theme.fontSize.xxl};
    }
    h3 {
      font-size: ${theme.fontSize.xl};
    }
    h4 {
      font-size: ${theme.fontSize.lg};
    }

    table {
      width: 100%;
      border-collapse: collapse;

      th,
      td {
        padding: ${theme.spacing.sm} ${theme.spacing.md};
        text-align: left;
        border-bottom: 1px solid ${theme.colors.border};
      }

      th {
        font-weight: ${theme.fontWeight.semibold};
        background: ${theme.colors.backgroundAlt};
      }

      tr:hover td {
        background: ${theme.colors.backgroundHover};
      }
    }
  }
`;
