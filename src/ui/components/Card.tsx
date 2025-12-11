import { styled } from '../setup.js';
import { theme } from '../styles/theme.js';
import type { ComponentChildren } from 'preact';

interface CardProps {
  children: ComponentChildren;
  className?: string;
  padding?: 'none' | 'sm' | 'md' | 'lg';
  hoverable?: boolean;
  onClick?: () => void;
}

interface StyledCardProps {
  $padding: string;
  $hoverable: boolean;
  $clickable: boolean;
}

const StyledCard = styled('div')<StyledCardProps>`
  background: ${theme.colors.background};
  border: 1px solid ${theme.colors.border};
  border-radius: ${theme.borderRadius.lg};
  padding: ${(p) => p.$padding};
  transition: all ${theme.transition.fast};
  cursor: ${(p) => (p.$clickable ? 'pointer' : 'default')};

  ${(p) =>
    p.$hoverable &&
    `
    &:hover {
      border-color: ${theme.colors.primary};
      box-shadow: ${theme.shadow.md};
    }
  `}
`;

const paddingMap: Record<string, string> = {
  none: '0',
  sm: theme.spacing.sm,
  md: theme.spacing.md,
  lg: theme.spacing.lg,
};

export function Card({
  children,
  className,
  padding = 'md',
  hoverable = false,
  onClick,
}: CardProps) {
  return (
    <StyledCard
      $padding={paddingMap[padding]}
      $hoverable={hoverable}
      $clickable={!!onClick}
      onClick={onClick}
      className={className}
    >
      {children}
    </StyledCard>
  );
}

// Card subcomponents
export const CardHeader = styled('div')`
  padding: ${theme.spacing.md};
  border-bottom: 1px solid ${theme.colors.border};
  font-weight: ${theme.fontWeight.semibold};
`;

export const CardContent = styled('div')`
  padding: ${theme.spacing.md};
`;

export const CardFooter = styled('div')`
  padding: ${theme.spacing.md};
  border-top: 1px solid ${theme.colors.border};
  background: ${theme.colors.backgroundAlt};
`;
