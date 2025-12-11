import { styled } from "../setup.js";
import { theme } from "../styles/theme.js";
import type { ComponentChildren } from "preact";

interface CodeBlockProps {
  children: ComponentChildren;
  language?: string;
  title?: string;
  maxHeight?: string;
}

const Container = styled("div")`
  border-radius: ${theme.borderRadius.md};
  overflow: hidden;
  background: ${theme.colors.codeBackground};
`;

const Header = styled("div")`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: ${theme.spacing.sm} ${theme.spacing.md};
  background: rgba(255, 255, 255, 0.05);
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
`;

const Title = styled("span")`
  font-size: ${theme.fontSize.xs};
  color: ${theme.colors.textLight};
  font-weight: ${theme.fontWeight.medium};
`;

const Language = styled("span")`
  font-size: ${theme.fontSize.xs};
  color: ${theme.colors.textLight};
  text-transform: uppercase;
`;

interface PreProps {
  $maxHeight?: string;
}

const Pre = styled("pre")<PreProps>`
  margin: 0;
  padding: ${theme.spacing.md};
  overflow: auto;
  font-family: "SF Mono", "Fira Code", "Consolas", monospace;
  font-size: ${theme.fontSize.sm};
  line-height: 1.5;
  color: ${theme.colors.codeText};
  white-space: pre;
  ${(p) => p.$maxHeight && `max-height: ${p.$maxHeight};`}
`;

const Code = styled("code")`
  font-family: inherit;
`;

export function CodeBlock({ children, language, title, maxHeight }: CodeBlockProps) {
  return (
    <Container>
      {(title || language) && (
        <Header>
          <Title>{title}</Title>
          {language && <Language>{language}</Language>}
        </Header>
      )}
      <Pre $maxHeight={maxHeight}>
        <Code>{children}</Code>
      </Pre>
    </Container>
  );
}
