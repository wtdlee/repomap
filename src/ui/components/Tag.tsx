import { styled } from "../setup.js";
import { theme } from "../styles/theme.js";
import type { ComponentChildren } from "preact";

export type TagVariant = 
  | "default" 
  | "primary" 
  | "success" 
  | "warning" 
  | "error"
  | "query"
  | "mutation"
  | "fragment"
  | "page"
  | "component"
  | "container"
  | "auth"
  | "public"
  | "repo";

const variantStyles: Record<TagVariant, { bg: string; color: string; border?: string }> = {
  default: { bg: theme.colors.backgroundAlt, color: theme.colors.text },
  primary: { bg: "#dbeafe", color: "#1e40af" },
  success: { bg: "#dcfce7", color: "#166534" },
  warning: { bg: "#fef3c7", color: "#92400e" },
  error: { bg: "#fee2e2", color: "#991b1b" },
  query: { bg: "#dbeafe", color: "#1e40af" },
  mutation: { bg: "#fae8ff", color: "#86198f" },
  fragment: { bg: "#f0fdf4", color: "#166534" },
  page: { bg: "#e0e7ff", color: "#3730a3" },
  component: { bg: "#fef3c7", color: "#92400e" },
  container: { bg: "#ffedd5", color: "#9a3412" },
  auth: { bg: "#fee2e2", color: "#991b1b" },
  public: { bg: "#dcfce7", color: "#166534" },
  repo: { bg: "#f1f5f9", color: "#475569", border: "#cbd5e1" },
};

interface TagProps {
  variant?: TagVariant;
  size?: "sm" | "md";
  onClick?: () => void;
  clickable?: boolean;
  children?: ComponentChildren;
  className?: string;
}

interface StyledTagProps {
  $variant: TagVariant;
  $size: "sm" | "md";
  $clickable: boolean;
}

const StyledTag = styled("span")<StyledTagProps>`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: ${(p: StyledTagProps) => (p.$size === "sm" ? "2px 6px" : "4px 10px")};
  font-size: ${(p: StyledTagProps) => (p.$size === "sm" ? theme.fontSize.xs : theme.fontSize.sm)};
  font-weight: ${theme.fontWeight.medium};
  border-radius: ${theme.borderRadius.sm};
  background: ${(p: StyledTagProps) => variantStyles[p.$variant].bg};
  color: ${(p: StyledTagProps) => variantStyles[p.$variant].color};
  border: 1px solid ${(p: StyledTagProps) => variantStyles[p.$variant].border || "transparent"};
  white-space: nowrap;
  cursor: ${(p: StyledTagProps) => (p.$clickable ? "pointer" : "default")};
  transition: opacity ${theme.transition.fast};
  
  &:hover {
    opacity: ${(p: StyledTagProps) => (p.$clickable ? "0.8" : "1")};
  }
`;

export function Tag({
  variant = "default",
  size = "sm",
  onClick,
  clickable = false,
  children,
  className,
}: TagProps) {
  return (
    <StyledTag
      $variant={variant}
      $size={size}
      $clickable={clickable || !!onClick}
      onClick={onClick}
      className={className}
    >
      {children}
    </StyledTag>
  );
}

// Convenience components
export const QueryTag = ({ children, ...props }: Omit<TagProps, "variant">) => (
  <Tag variant="query" {...props}>{children ?? "QUERY"}</Tag>
);

export const MutationTag = ({ children, ...props }: Omit<TagProps, "variant">) => (
  <Tag variant="mutation" {...props}>{children ?? "MUTATION"}</Tag>
);

export const FragmentTag = ({ children, ...props }: Omit<TagProps, "variant">) => (
  <Tag variant="fragment" {...props}>{children ?? "FRAGMENT"}</Tag>
);

export const AuthTag = ({ children, ...props }: Omit<TagProps, "variant">) => (
  <Tag variant="auth" {...props}>{children ?? "AUTH"}</Tag>
);

export const PublicTag = ({ children, ...props }: Omit<TagProps, "variant">) => (
  <Tag variant="public" {...props}>{children ?? "PUBLIC"}</Tag>
);

export const PageTag = ({ children, ...props }: Omit<TagProps, "variant">) => (
  <Tag variant="page" {...props}>{children ?? "PAGE"}</Tag>
);

export const ComponentTag = ({ children, ...props }: Omit<TagProps, "variant">) => (
  <Tag variant="component" {...props}>{children ?? "COMPONENT"}</Tag>
);

export const ContainerTag = ({ children, ...props }: Omit<TagProps, "variant">) => (
  <Tag variant="container" {...props}>{children ?? "CONTAINER"}</Tag>
);

export const RepoTag = ({ children, ...props }: Omit<TagProps, "variant">) => (
  <Tag variant="repo" {...props}>{children}</Tag>
);
