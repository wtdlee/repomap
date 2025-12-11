import { styled } from "../setup.js";
import { theme } from "../styles/theme.js";
import type { ComponentChildren, JSX } from "preact";

type ButtonVariant = "primary" | "secondary" | "ghost" | "outline";
type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  onClick?: (e: JSX.TargetedMouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  children: ComponentChildren;
  className?: string;
  type?: "button" | "submit" | "reset";
}

const sizeStyles: Record<ButtonSize, { padding: string; fontSize: string }> = {
  sm: { padding: "4px 8px", fontSize: theme.fontSize.xs },
  md: { padding: "8px 16px", fontSize: theme.fontSize.sm },
  lg: { padding: "12px 24px", fontSize: theme.fontSize.md },
};

const variantStyles: Record<ButtonVariant, { bg: string; color: string; border: string; hoverBg: string }> = {
  primary: {
    bg: theme.colors.primary,
    color: "#ffffff",
    border: theme.colors.primary,
    hoverBg: theme.colors.primaryHover,
  },
  secondary: {
    bg: theme.colors.backgroundAlt,
    color: theme.colors.text,
    border: theme.colors.border,
    hoverBg: theme.colors.backgroundHover,
  },
  ghost: {
    bg: "transparent",
    color: theme.colors.text,
    border: "transparent",
    hoverBg: theme.colors.backgroundHover,
  },
  outline: {
    bg: "transparent",
    color: theme.colors.primary,
    border: theme.colors.primary,
    hoverBg: "#eff6ff",
  },
};

interface StyledButtonProps {
  $variant: ButtonVariant;
  $size: ButtonSize;
}

const StyledButton = styled("button")<StyledButtonProps>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: ${(p: StyledButtonProps) => sizeStyles[p.$size].padding};
  font-size: ${(p: StyledButtonProps) => sizeStyles[p.$size].fontSize};
  font-weight: ${theme.fontWeight.medium};
  border-radius: ${theme.borderRadius.md};
  background: ${(p: StyledButtonProps) => variantStyles[p.$variant].bg};
  color: ${(p: StyledButtonProps) => variantStyles[p.$variant].color};
  border: 1px solid ${(p: StyledButtonProps) => variantStyles[p.$variant].border};
  cursor: pointer;
  transition: all ${theme.transition.fast};
  
  &:hover:not(:disabled) {
    background: ${(p: StyledButtonProps) => variantStyles[p.$variant].hoverBg};
  }
  
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  
  &:focus {
    outline: none;
    box-shadow: 0 0 0 2px ${theme.colors.primary}33;
  }
`;

export function Button({
  variant = "primary",
  size = "md",
  onClick,
  disabled,
  children,
  className,
  type = "button",
}: ButtonProps) {
  return (
    <StyledButton
      $variant={variant}
      $size={size}
      onClick={onClick}
      disabled={disabled}
      className={className}
      type={type}
    >
      {children}
    </StyledButton>
  );
}
