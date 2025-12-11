import { styled } from "../setup.js";
import { theme } from "../styles/theme.js";
import type { JSX } from "preact";

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

const Container = styled("div")`
  position: relative;
  width: 100%;
`;

const Icon = styled("span")`
  position: absolute;
  left: ${theme.spacing.sm};
  top: 50%;
  transform: translateY(-50%);
  color: ${theme.colors.textMuted};
  pointer-events: none;
`;

const Input = styled("input")`
  width: 100%;
  padding: ${theme.spacing.sm} ${theme.spacing.md};
  padding-left: ${theme.spacing.xl};
  font-size: ${theme.fontSize.sm};
  border: 1px solid ${theme.colors.border};
  border-radius: ${theme.borderRadius.md};
  background: ${theme.colors.background};
  color: ${theme.colors.text};
  transition: all ${theme.transition.fast};
  
  &:focus {
    outline: none;
    border-color: ${theme.colors.primary};
    box-shadow: 0 0 0 3px ${theme.colors.primary}22;
  }
  
  &::placeholder {
    color: ${theme.colors.textLight};
  }
`;

export function SearchInput({
  value,
  onChange,
  placeholder = "Search...",
  className,
}: SearchInputProps) {
  const handleInput = (e: JSX.TargetedEvent<HTMLInputElement>) => {
    onChange((e.target as HTMLInputElement).value);
  };

  return (
    <Container className={className}>
      <Icon>🔍</Icon>
      <Input
        type="text"
        value={value}
        onInput={handleInput}
        placeholder={placeholder}
      />
    </Container>
  );
}
