import { styled } from '../setup.js';
import { theme } from '../styles/theme.js';
import { AuthTag, PublicTag, RepoTag } from '../components/Tag.js';
import { SearchInput } from '../components/SearchInput.js';
import type { PageInfo, DocumentationReport } from '../../types.js';

interface PageMapProps {
  report: DocumentationReport;
}

// Styled components
const Container = styled('div')`
  display: flex;
  height: 100vh;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
`;

const Sidebar = styled('aside')`
  width: 400px;
  background: ${theme.colors.backgroundAlt};
  border-right: 1px solid ${theme.colors.border};
  display: flex;
  flex-direction: column;
  overflow: hidden;
`;

const Header = styled('header')`
  padding: ${theme.spacing.lg};
  border-bottom: 1px solid ${theme.colors.border};
`;

const Title = styled('h1')`
  font-size: ${theme.fontSize.xl};
  font-weight: ${theme.fontWeight.bold};
  margin: 0 0 ${theme.spacing.md} 0;
`;

const ViewToggle = styled('div')`
  display: flex;
  gap: ${theme.spacing.sm};
  margin-top: ${theme.spacing.md};
`;

interface ToggleButtonProps {
  $active?: boolean;
}

const ToggleButton = styled('button')<ToggleButtonProps>`
  flex: 1;
  padding: ${theme.spacing.sm};
  font-size: ${theme.fontSize.sm};
  font-weight: ${theme.fontWeight.medium};
  border: 1px solid ${theme.colors.border};
  border-radius: ${theme.borderRadius.md};
  cursor: pointer;
  transition: all ${theme.transition.fast};
  background: ${(p) => (p.$active ? theme.colors.primary : theme.colors.background)};
  color: ${(p) => (p.$active ? '#fff' : theme.colors.text)};

  &:hover {
    background: ${(p) => (p.$active ? theme.colors.primaryHover : theme.colors.backgroundHover)};
  }
`;

const PageList = styled('div')`
  flex: 1;
  overflow-y: auto;
  padding: ${theme.spacing.md};
`;

const PageGroup = styled('div')`
  margin-bottom: ${theme.spacing.lg};
`;

const GroupTitle = styled('h3')`
  font-size: ${theme.fontSize.sm};
  font-weight: ${theme.fontWeight.semibold};
  color: ${theme.colors.textMuted};
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: ${theme.spacing.sm};
  padding: 0 ${theme.spacing.sm};
`;

interface PageItemProps {
  $depth: number;
}

const PageItem = styled('div')<PageItemProps>`
  display: flex;
  align-items: center;
  gap: ${theme.spacing.sm};
  padding: ${theme.spacing.sm};
  padding-left: ${(p) => 8 + p.$depth * 20}px;
  border-radius: ${theme.borderRadius.sm};
  cursor: pointer;
  transition: background ${theme.transition.fast};

  &:hover {
    background: ${theme.colors.backgroundHover};
  }
`;

interface PageTypeTagProps {
  $type: string;
}

const PageTypeTag = styled('span')<PageTypeTagProps>`
  min-width: 52px;
  text-align: center;
  padding: 2px 6px;
  font-size: ${theme.fontSize.xs};
  font-weight: ${theme.fontWeight.medium};
  border-radius: ${theme.borderRadius.sm};
  background: ${(p) => {
    switch (p.$type) {
      case 'PAGE':
        return '#e0e7ff';
      case 'DYNAMIC':
        return '#fef3c7';
      case 'LAYOUT':
        return '#dbeafe';
      default:
        return theme.colors.backgroundAlt;
    }
  }};
  color: ${(p) => {
    switch (p.$type) {
      case 'PAGE':
        return '#3730a3';
      case 'DYNAMIC':
        return '#92400e';
      case 'LAYOUT':
        return '#1e40af';
      default:
        return theme.colors.text;
    }
  }};
`;

const PagePath = styled('span')`
  flex: 1;
  font-size: ${theme.fontSize.sm};
  color: ${theme.colors.text};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const PageMeta = styled('div')`
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: ${theme.fontSize.xs};
  color: ${theme.colors.textMuted};
`;

const MainContent = styled('main')`
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: ${theme.colors.background};
  color: ${theme.colors.textMuted};
`;

const EmptyState = styled('div')`
  text-align: center;
`;

// Helper to determine page type
function getPageType(path: string): string {
  if (path.includes('[') && path.includes(']')) return 'DYNAMIC';
  if (path.includes('_app') || path.includes('_document') || path.includes('layout'))
    return 'LAYOUT';
  return 'PAGE';
}

// Helper to group pages
function groupPages(
  pages: Array<PageInfo & { repo?: string }>
): Record<string, Array<PageInfo & { repo?: string }>> {
  const groups: Record<string, Array<PageInfo & { repo?: string }>> = {};

  for (const page of pages) {
    const segments = page.path.split('/').filter(Boolean);
    const group = segments[0] || 'root';

    if (!groups[group]) {
      groups[group] = [];
    }
    groups[group].push(page);
  }

  return groups;
}

// Calculate depth for indentation
function getDepth(path: string, groupPath: string): number {
  const segments = path.split('/').filter(Boolean);
  const groupSegments = groupPath.split('/').filter(Boolean);
  return Math.max(0, segments.length - groupSegments.length - 1);
}

export function PageMap({ report }: PageMapProps) {
  // Collect all pages from all repositories
  const allPages: Array<PageInfo & { repo: string }> = [];
  const showRepoTag = report.repositories.length > 1;

  for (const repo of report.repositories) {
    const pages = repo.analysis?.pages || [];
    for (const page of pages) {
      allPages.push({ ...page, repo: repo.name });
    }
  }

  const grouped = groupPages(allPages);
  const groupNames = Object.keys(grouped).sort();

  return (
    <Container>
      <Sidebar>
        <Header>
          <Title>Page Map</Title>
          <SearchInput value="" onChange={() => {}} placeholder="Search pages..." />
          <ViewToggle>
            <ToggleButton $active>List</ToggleButton>
            <ToggleButton>Graph</ToggleButton>
          </ViewToggle>
        </Header>

        <PageList>
          {groupNames.map((group) => {
            const pages = grouped[group];
            return (
              <PageGroup key={group}>
                <GroupTitle>/{group}</GroupTitle>
                {pages.map((page) => {
                  const depth = getDepth(page.path, group);
                  const type = getPageType(page.path);
                  const queries =
                    page.dataFetching?.filter((d) => d.type === 'useQuery').length || 0;
                  const mutations =
                    page.dataFetching?.filter((d) => d.type === 'useMutation').length || 0;
                  const repoName = page.repo || '';
                  const shortRepo =
                    repoName
                      .split('/')
                      .pop()
                      ?.split('-')
                      .map((s: string) => s.substring(0, 4))
                      .join('-') || repoName;

                  return (
                    <PageItem key={page.path} $depth={depth} data-path={page.path}>
                      <PageTypeTag $type={type}>{type}</PageTypeTag>
                      {showRepoTag && <RepoTag size="sm">{shortRepo}</RepoTag>}
                      <PagePath>{page.path}</PagePath>
                      <PageMeta>
                        {page.authentication?.required ? (
                          <AuthTag size="sm" />
                        ) : (
                          <PublicTag size="sm" />
                        )}
                        {queries > 0 && <span>Q:{queries}</span>}
                        {mutations > 0 && <span>M:{mutations}</span>}
                      </PageMeta>
                    </PageItem>
                  );
                })}
              </PageGroup>
            );
          })}
        </PageList>
      </Sidebar>

      <MainContent>
        <EmptyState>
          <p>Select a page to view details</p>
        </EmptyState>
      </MainContent>
    </Container>
  );
}
