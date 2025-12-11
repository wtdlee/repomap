import { styled } from '../setup.js';
import { theme } from '../styles/theme.js';
import type { ComponentChildren } from 'preact';

// Styled table components
export const Table = styled('table')`
  width: 100%;
  border-collapse: collapse;
  font-size: ${theme.fontSize.sm};
`;

export const Thead = styled('thead')`
  background: ${theme.colors.backgroundAlt};
`;

export const Tbody = styled('tbody')``;

interface TrProps {
  $hoverable?: boolean;
}

export const Tr = styled('tr')<TrProps>`
  border-bottom: 1px solid ${theme.colors.border};

  ${(p) =>
    p.$hoverable &&
    `
    &:hover {
      background: ${theme.colors.backgroundHover};
    }
  `}
`;

interface ThProps {
  $width?: string;
  $align?: 'left' | 'center' | 'right';
}

export const Th = styled('th')<ThProps>`
  padding: ${theme.spacing.sm} ${theme.spacing.md};
  text-align: ${(p) => p.$align || 'left'};
  font-weight: ${theme.fontWeight.semibold};
  color: ${theme.colors.text};
  white-space: nowrap;
  ${(p) => p.$width && `width: ${p.$width};`}
`;

interface TdProps {
  $align?: 'left' | 'center' | 'right';
}

export const Td = styled('td')<TdProps>`
  padding: ${theme.spacing.sm} ${theme.spacing.md};
  text-align: ${(p) => p.$align || 'left'};
  color: ${theme.colors.text};
  vertical-align: top;
`;

// Responsive table wrapper
export const TableWrapper = styled('div')`
  overflow-x: auto;
  border: 1px solid ${theme.colors.border};
  border-radius: ${theme.borderRadius.md};
`;

// Simple table component with data
interface SimpleTableProps {
  headers: string[];
  rows: ComponentChildren[][];
  hoverable?: boolean;
}

export function SimpleTable({ headers, rows, hoverable = true }: SimpleTableProps) {
  return (
    <TableWrapper>
      <Table>
        <Thead>
          <Tr>
            {headers.map((header, i) => (
              <Th key={i}>{header}</Th>
            ))}
          </Tr>
        </Thead>
        <Tbody>
          {rows.map((row, i) => (
            <Tr key={i} $hoverable={hoverable}>
              {row.map((cell, j) => (
                <Td key={j}>{cell}</Td>
              ))}
            </Tr>
          ))}
        </Tbody>
      </Table>
    </TableWrapper>
  );
}
