import { styled } from '../setup.js';
import { theme } from '../styles/theme.js';
import type { ComponentChildren } from 'preact';

interface DocLayoutProps {
  title: string;
  sidebar?: ComponentChildren;
  children: ComponentChildren;
}

const Container = styled('div')`
  display: flex;
  min-height: 100vh;
`;

const Sidebar = styled('aside')`
  width: 260px;
  flex-shrink: 0;
  background: ${theme.colors.backgroundAlt};
  border-right: 1px solid ${theme.colors.border};
  overflow-y: auto;
  position: sticky;
  top: 0;
  height: 100vh;
`;

const SidebarHeader = styled('div')`
  padding: ${theme.spacing.lg};
  border-bottom: 1px solid ${theme.colors.border};
`;

const SidebarTitle = styled('h1')`
  font-size: ${theme.fontSize.lg};
  font-weight: ${theme.fontWeight.bold};
  color: ${theme.colors.text};
  margin: 0;
`;

const SidebarNav = styled('nav')`
  padding: ${theme.spacing.md};
`;

const Main = styled('main')`
  flex: 1;
  overflow-x: hidden;
`;

const Content = styled('div')`
  max-width: 1200px;
  margin: 0 auto;
  padding: ${theme.spacing.xl};
`;

export function DocLayout({ title, sidebar, children }: DocLayoutProps) {
  return (
    <Container>
      <Sidebar>
        <SidebarHeader>
          <SidebarTitle>{title}</SidebarTitle>
        </SidebarHeader>
        <SidebarNav>{sidebar}</SidebarNav>
      </Sidebar>
      <Main>
        <Content>{children}</Content>
      </Main>
    </Container>
  );
}

// Navigation components for sidebar
export const NavSection = styled('div')`
  margin-bottom: ${theme.spacing.lg};
`;

export const NavSectionTitle = styled('h3')`
  font-size: ${theme.fontSize.xs};
  font-weight: ${theme.fontWeight.semibold};
  color: ${theme.colors.textMuted};
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: ${theme.spacing.sm};
`;

interface NavLinkProps {
  $active?: boolean;
}

export const NavLink = styled('a')<NavLinkProps>`
  display: block;
  padding: ${theme.spacing.xs} ${theme.spacing.sm};
  font-size: ${theme.fontSize.sm};
  color: ${(p) => (p.$active ? theme.colors.primary : theme.colors.text)};
  background: ${(p) => (p.$active ? `${theme.colors.primary}11` : 'transparent')};
  border-radius: ${theme.borderRadius.sm};
  text-decoration: none;
  transition: all ${theme.transition.fast};

  &:hover {
    background: ${theme.colors.backgroundHover};
    text-decoration: none;
  }
`;
