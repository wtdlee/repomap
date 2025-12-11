import { styled } from "../setup.js";
import { theme } from "../styles/theme.js";
import { Tag, QueryTag, MutationTag, FragmentTag } from "./Tag.js";
import type { ComponentChildren } from "preact";

interface TagListProps {
  children: ComponentChildren;
  gap?: "sm" | "md";
  wrap?: boolean;
  className?: string;
}

interface ContainerProps {
  $gap: string;
  $wrap: boolean;
}

const Container = styled("div")<ContainerProps>`
  display: flex;
  flex-wrap: ${(p) => (p.$wrap ? "wrap" : "nowrap")};
  gap: ${(p) => p.$gap};
  align-items: center;
`;

const gapMap: Record<string, string> = {
  sm: theme.spacing.xs,
  md: theme.spacing.sm,
};

export function TagList({
  children,
  gap = "sm",
  wrap = true,
  className,
}: TagListProps) {
  return (
    <Container $gap={gapMap[gap]} $wrap={wrap} className={className}>
      {children}
    </Container>
  );
}

// GraphQL operations tag list with "more" support
interface GqlOpsListProps {
  queries?: string[];
  mutations?: string[];
  fragments?: string[];
  maxVisible?: number;
  onClickOp?: (name: string, type: string) => void;
  onClickMore?: () => void;
}

const MoreButton = styled("button")`
  display: inline-flex;
  align-items: center;
  padding: 2px 6px;
  font-size: ${theme.fontSize.xs};
  font-weight: ${theme.fontWeight.medium};
  color: ${theme.colors.textMuted};
  background: ${theme.colors.backgroundAlt};
  border: 1px dashed ${theme.colors.border};
  border-radius: ${theme.borderRadius.sm};
  cursor: pointer;
  
  &:hover {
    background: ${theme.colors.backgroundHover};
    color: ${theme.colors.text};
  }
`;

export function GqlOpsList({
  queries = [],
  mutations = [],
  fragments = [],
  maxVisible = 3,
  onClickOp,
  onClickMore,
}: GqlOpsListProps) {
  const allOps = [
    ...queries.map((name) => ({ name, type: "query" as const })),
    ...mutations.map((name) => ({ name, type: "mutation" as const })),
    ...fragments.map((name) => ({ name, type: "fragment" as const })),
  ];

  const visible = allOps.slice(0, maxVisible);
  const remaining = allOps.length - maxVisible;

  return (
    <TagList>
      {visible.map((op) => {
        const handleClick = onClickOp ? () => onClickOp(op.name, op.type) : undefined;
        
        if (op.type === "query") {
          return <QueryTag key={`q-${op.name}`} clickable={!!onClickOp} onClick={handleClick}>{op.name}</QueryTag>;
        }
        if (op.type === "mutation") {
          return <MutationTag key={`m-${op.name}`} clickable={!!onClickOp} onClick={handleClick}>{op.name}</MutationTag>;
        }
        return <FragmentTag key={`f-${op.name}`} clickable={!!onClickOp} onClick={handleClick}>{op.name}</FragmentTag>;
      })}
      {remaining > 0 && (
        <MoreButton onClick={onClickMore}>
          +{remaining} more
        </MoreButton>
      )}
    </TagList>
  );
}
