import { h, Fragment } from 'preact';
import { useState, useEffect, useMemo, useCallback } from 'preact/hooks';
import { styled, css } from '../setup.js';
import { darkTheme as theme } from '../styles/darkTheme.js';
import type {
  PageInfo,
  DocumentationReport,
  GraphQLOperation,
  APICall,
  ComponentInfo,
} from '../../types.js';

// Types
interface PageNode extends PageInfo {
  repo: string;
  children: string[];
  parent: string | null;
  depth: number;
}

interface Relation {
  from: string;
  to: string;
  type: 'parent-child' | 'same-layout' | 'navigation';
}

type ViewMode = 'tree' | 'graph';
type FilterType = 'pages' | 'hierarchies' | 'graphql' | 'restapi' | null;

// Props
interface PageMapV2Props {
  report: DocumentationReport;
}

// Styled Components
const Container = styled('div')`
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: ${theme.colors.background};
  color: ${theme.colors.text};
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
`;

const Header = styled('header')`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: ${theme.spacing.md};
  background: ${theme.colors.backgroundAlt};
  border-bottom: 1px solid ${theme.colors.border};
`;

const Title = styled('h1')`
  font-size: ${theme.fontSize.xl};
  font-weight: ${theme.fontWeight.bold};
  margin: 0;
`;

const HeaderControls = styled('div')`
  display: flex;
  align-items: center;
  gap: ${theme.spacing.md};
`;

const SearchInput = styled('input')`
  padding: ${theme.spacing.sm} ${theme.spacing.md};
  background: ${theme.colors.backgroundHover};
  border: 1px solid ${theme.colors.border};
  border-radius: ${theme.borderRadius.md};
  color: ${theme.colors.text};
  font-size: ${theme.fontSize.md};
  width: 240px;

  &::placeholder {
    color: ${theme.colors.textMuted};
  }

  &:focus {
    outline: none;
    border-color: ${theme.colors.primary};
  }
`;

const ViewTabs = styled('div')`
  display: flex;
  gap: ${theme.spacing.xs};
`;

interface TabButtonProps {
  $active?: boolean;
}

const TabButton = styled('button')<TabButtonProps>`
  padding: ${theme.spacing.sm} ${theme.spacing.md};
  background: ${(p) => (p.$active ? theme.colors.primary : theme.colors.backgroundHover)};
  color: ${(p) => (p.$active ? '#fff' : theme.colors.text)};
  border: none;
  border-radius: ${theme.borderRadius.md};
  cursor: pointer;
  font-size: ${theme.fontSize.md};
  font-weight: ${theme.fontWeight.medium};
  transition: all ${theme.transition.fast};

  &:hover {
    background: ${(p) => (p.$active ? theme.colors.primaryHover : theme.colors.bg3)};
  }
`;

const MainContent = styled('div')`
  display: flex;
  flex: 1;
  overflow: hidden;
`;

const Sidebar = styled('aside')`
  width: 280px;
  background: ${theme.colors.backgroundAlt};
  border-right: 1px solid ${theme.colors.border};
  overflow-y: auto;
  padding: ${theme.spacing.md};
`;

const SidebarSection = styled('div')`
  margin-bottom: ${theme.spacing.lg};
`;

const SectionTitle = styled('h3')`
  font-size: ${theme.fontSize.xs};
  font-weight: ${theme.fontWeight.semibold};
  color: ${theme.colors.textMuted};
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin: 0 0 ${theme.spacing.sm} 0;
`;

const LegendItem = styled('div')`
  display: flex;
  align-items: center;
  gap: ${theme.spacing.sm};
  padding: ${theme.spacing.xs} 0;
  font-size: ${theme.fontSize.sm};
`;

interface LegendColorProps {
  $color: string;
}

const LegendColor = styled('span')<LegendColorProps>`
  width: 12px;
  height: 12px;
  border-radius: ${theme.borderRadius.sm};
  background: ${(p) => p.$color};
`;

const StatsGrid = styled('div')`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: ${theme.spacing.sm};
  margin-top: ${theme.spacing.md};
`;

interface StatCardProps {
  $active?: boolean;
}

const StatCard = styled('div')<StatCardProps>`
  background: ${(p) => (p.$active ? '#1e3a5f' : theme.colors.bg3)};
  padding: ${theme.spacing.md};
  border-radius: ${theme.borderRadius.md};
  text-align: center;
  cursor: pointer;
  transition: all ${theme.transition.fast};
  border: 2px solid ${(p) => (p.$active ? theme.colors.accent : 'transparent')};

  &:hover {
    background: ${theme.colors.backgroundHover};
  }
`;

const StatValue = styled('div')`
  font-size: ${theme.fontSize.xxl};
  font-weight: ${theme.fontWeight.bold};
`;

const StatLabel = styled('div')`
  font-size: ${theme.fontSize.xs};
  color: ${theme.colors.textMuted};
`;

const ContentArea = styled('div')`
  flex: 1;
  overflow: hidden;
  position: relative;
`;

const TreeView = styled('div')`
  height: 100%;
  overflow-y: auto;
  padding: ${theme.spacing.md};
`;

const PageGroup = styled('div')`
  background: ${theme.colors.backgroundAlt};
  border-radius: ${theme.borderRadius.lg};
  margin-bottom: ${theme.spacing.md};
  overflow: hidden;
`;

const GroupHeader = styled('div')`
  display: flex;
  align-items: center;
  gap: ${theme.spacing.sm};
  padding: ${theme.spacing.sm} ${theme.spacing.md};
  cursor: pointer;
  border-left: 3px solid ${theme.colors.accent};

  &:hover {
    background: ${theme.colors.bg3};
  }
`;

const GroupName = styled('span')`
  font-family: monospace;
  font-weight: ${theme.fontWeight.semibold};
  flex: 1;
`;

const GroupCount = styled('span')`
  font-size: ${theme.fontSize.xs};
  color: ${theme.colors.textMuted};
  background: ${theme.colors.bg3};
  padding: 2px 8px;
  border-radius: 10px;
`;

interface PageItemProps {
  $depth?: number;
  $selected?: boolean;
}

const PageItem = styled('div')<PageItemProps>`
  display: flex;
  align-items: center;
  padding: ${theme.spacing.sm} ${theme.spacing.md};
  padding-left: ${(p) => 14 + (p.$depth || 0) * 16}px;
  border-top: 1px solid ${theme.colors.border};
  cursor: pointer;
  gap: ${theme.spacing.sm};
  background: ${(p) => (p.$selected ? theme.colors.bg3 : 'transparent')};
  border-left: ${(p) => (p.$selected ? `2px solid ${theme.colors.accent}` : 'none')};

  &:hover {
    background: ${theme.colors.bg3};
  }
`;

interface PageTypeTagProps {
  $type: string;
}

const PageTypeTag = styled('span')<PageTypeTagProps>`
  font-size: ${theme.fontSize.xs};
  padding: 2px 6px;
  border-radius: ${theme.borderRadius.sm};
  font-weight: ${theme.fontWeight.medium};
  min-width: 52px;
  text-align: center;
  background: ${(p) => {
    switch (p.$type) {
      case 'CREATE':
        return '#22c55e';
      case 'EDIT':
        return '#f59e0b';
      case 'DETAIL':
        return '#3b82f6';
      case 'LIST':
        return '#06b6d4';
      default:
        return '#64748b';
    }
  }};
  color: white;
`;

const PagePath = styled('span')`
  flex: 1;
  font-family: monospace;
  font-size: ${theme.fontSize.sm};
  color: ${theme.colors.accent};
`;

const PageMeta = styled('div')`
  display: flex;
  align-items: center;
  gap: 4px;
`;

const Tag = styled('span')<{ $variant?: string }>`
  font-size: ${theme.fontSize.xs};
  padding: 2px 5px;
  border-radius: ${theme.borderRadius.sm};
  background: ${(p) => {
    switch (p.$variant) {
      case 'auth':
        return theme.colors.tagAuth;
      case 'query':
        return theme.colors.tagQuery;
      case 'mutation':
        return theme.colors.tagMutation;
      default:
        return theme.colors.bg3;
    }
  }};
  color: ${(p) => {
    switch (p.$variant) {
      case 'auth':
        return theme.colors.tagAuthText;
      case 'query':
        return theme.colors.tagQueryText;
      case 'mutation':
        return theme.colors.tagMutationText;
      default:
        return theme.colors.textMuted;
    }
  }};
`;

// Detail Panel
const DetailPanel = styled('div')<{ $open?: boolean }>`
  position: absolute;
  top: 0;
  right: ${(p) => (p.$open ? '0' : '-400px')};
  width: 400px;
  height: 100%;
  background: ${theme.colors.backgroundAlt};
  border-left: 1px solid ${theme.colors.border};
  transition: right ${theme.transition.normal};
  overflow-y: auto;
  z-index: 100;
`;

const DetailHeader = styled('div')`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: ${theme.spacing.md};
  border-bottom: 1px solid ${theme.colors.border};
  position: sticky;
  top: 0;
  background: ${theme.colors.backgroundAlt};
`;

const DetailTitle = styled('div')`
  font-family: monospace;
  font-size: ${theme.fontSize.md};
  word-break: break-all;
`;

const CloseButton = styled('button')`
  background: none;
  border: none;
  color: ${theme.colors.textMuted};
  font-size: 18px;
  cursor: pointer;

  &:hover {
    color: ${theme.colors.text};
  }
`;

const DetailBody = styled('div')`
  padding: ${theme.spacing.md};
`;

const DetailSection = styled('div')`
  margin-bottom: ${theme.spacing.md};
`;

const DetailSectionTitle = styled('h4')`
  font-size: ${theme.fontSize.xs};
  text-transform: uppercase;
  color: ${theme.colors.textMuted};
  margin: 0 0 ${theme.spacing.sm} 0;
`;

const DetailItem = styled('div')`
  background: ${theme.colors.bg3};
  padding: ${theme.spacing.sm} ${theme.spacing.md};
  border-radius: ${theme.borderRadius.sm};
  margin-bottom: ${theme.spacing.xs};
  font-size: ${theme.fontSize.sm};
`;

const DetailLabel = styled('div')`
  font-size: ${theme.fontSize.xs};
  color: ${theme.colors.textMuted};
  margin-bottom: 2px;
`;

// Helper functions
function getPageType(page: PageNode): string {
  const path = page.path.toLowerCase();
  if (path.includes('/new') || path.includes('/create')) return 'CREATE';
  if (path.includes('/edit') || path.includes('[') || path.includes(':')) return 'EDIT';
  if (path.match(/\/\d+$/) || path.includes('/detail')) return 'DETAIL';
  return 'LIST';
}

function groupPages(pages: PageNode[]): Record<string, PageNode[]> {
  const groups: Record<string, PageNode[]> = {};

  for (const page of pages) {
    const segments = page.path.split('/').filter(Boolean);
    const group = segments[0] || 'root';

    if (!groups[group]) {
      groups[group] = [];
    }
    groups[group].push(page);
  }

  // Sort within groups
  for (const group of Object.keys(groups)) {
    groups[group].sort((a, b) => a.path.localeCompare(b.path));
  }

  return groups;
}

function buildRelations(pages: PageNode[]): Relation[] {
  const relations: Relation[] = [];
  const pageMap = new Map(pages.map((p) => [p.path, p]));

  for (const page of pages) {
    // Parent-child relations
    const segments = page.path.split('/').filter(Boolean);
    if (segments.length > 1) {
      const parentPath = '/' + segments.slice(0, -1).join('/');
      if (pageMap.has(parentPath)) {
        relations.push({ from: parentPath, to: page.path, type: 'parent-child' });
      }
    }

    // Same layout relations
    if (page.layout) {
      for (const other of pages) {
        if (other.path !== page.path && other.layout === page.layout) {
          const key = [page.path, other.path].sort().join('|');
          if (
            !relations.some(
              (r) => [r.from, r.to].sort().join('|') === key && r.type === 'same-layout'
            )
          ) {
            relations.push({ from: page.path, to: other.path, type: 'same-layout' });
          }
        }
      }
    }
  }

  return relations;
}

// Main Component
export function PageMapV2({ report }: PageMapV2Props) {
  // State
  const [viewMode, setViewMode] = useState<ViewMode>('tree');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<FilterType>(null);
  const [selectedPage, setSelectedPage] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // Derived data
  const allPages = useMemo<PageNode[]>(() => {
    const pages: PageNode[] = [];
    for (const repo of report.repositories) {
      for (const page of repo.analysis?.pages || []) {
        pages.push({
          ...page,
          repo: repo.name,
          children: [],
          parent: null,
          depth: 0,
        });
      }
    }
    return pages;
  }, [report]);

  const graphqlOps = useMemo<GraphQLOperation[]>(() => {
    const ops: GraphQLOperation[] = [];
    for (const repo of report.repositories) {
      ops.push(...(repo.analysis?.graphqlOperations || []));
    }
    return ops;
  }, [report]);

  const apiCalls = useMemo<APICall[]>(() => {
    const calls: APICall[] = [];
    for (const repo of report.repositories) {
      calls.push(...(repo.analysis?.apiCalls || []));
    }
    return calls;
  }, [report]);

  const components = useMemo<ComponentInfo[]>(() => {
    const comps: ComponentInfo[] = [];
    for (const repo of report.repositories) {
      comps.push(...(repo.analysis?.components || []));
    }
    return comps;
  }, [report]);

  const relations = useMemo(() => buildRelations(allPages), [allPages]);

  const filteredPages = useMemo(() => {
    let pages = allPages;

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      pages = pages.filter(
        (p) => p.path.toLowerCase().includes(query) || p.filePath.toLowerCase().includes(query)
      );
    }

    return pages;
  }, [allPages, searchQuery]);

  const groupedPages = useMemo(() => groupPages(filteredPages), [filteredPages]);

  const selectedPageData = useMemo(() => {
    if (!selectedPage) return null;
    return allPages.find((p) => p.path === selectedPage) || null;
  }, [selectedPage, allPages]);

  // Handlers
  const handleStatClick = useCallback((filter: FilterType) => {
    setActiveFilter((prev) => (prev === filter ? null : filter));
    if (filter === 'graphql' || filter === 'restapi') {
      setSelectedPage(null);
    }
  }, []);

  const handlePageClick = useCallback((path: string) => {
    setSelectedPage(path);
    setActiveFilter(null);
  }, []);

  const toggleGroup = useCallback((group: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
  }, []);

  const closeDetail = useCallback(() => {
    setSelectedPage(null);
    setActiveFilter(null);
  }, []);

  // Stats
  const hierarchyCount = relations.filter((r) => r.type === 'parent-child').length;

  return (
    <Container>
      <Header>
        <Title>Page Map</Title>
        <HeaderControls>
          <SearchInput
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
          />
          <ViewTabs>
            <TabButton $active={viewMode === 'tree'} onClick={() => setViewMode('tree')}>
              List
            </TabButton>
            <TabButton $active={viewMode === 'graph'} onClick={() => setViewMode('graph')}>
              Graph
            </TabButton>
          </ViewTabs>
        </HeaderControls>
      </Header>

      <MainContent>
        <Sidebar>
          <SidebarSection>
            <SectionTitle>Page Types</SectionTitle>
            <LegendItem>
              <LegendColor $color="#22c55e" />
              CREATE
            </LegendItem>
            <LegendItem>
              <LegendColor $color="#f59e0b" />
              EDIT
            </LegendItem>
            <LegendItem>
              <LegendColor $color="#3b82f6" />
              DETAIL
            </LegendItem>
            <LegendItem>
              <LegendColor $color="#06b6d4" />
              LIST
            </LegendItem>
          </SidebarSection>

          <SidebarSection>
            <SectionTitle>Relationships</SectionTitle>
            <LegendItem>
              <LegendColor $color="#3b82f6" />
              PARENT
            </LegendItem>
            <LegendItem>
              <LegendColor $color="#22c55e" />
              CHILD
            </LegendItem>
            <LegendItem>
              <LegendColor $color="#8b5cf6" />
              SAME LAYOUT
            </LegendItem>
          </SidebarSection>

          <SidebarSection>
            <SectionTitle>Data</SectionTitle>
            <LegendItem>
              <Tag $variant="query">QUERY</Tag>
              fetch data
            </LegendItem>
            <LegendItem>
              <Tag $variant="mutation">MUTATION</Tag>
              update
            </LegendItem>
          </SidebarSection>

          <StatsGrid>
            <StatCard $active={activeFilter === 'pages'} onClick={() => handleStatClick('pages')}>
              <StatValue>{allPages.length}</StatValue>
              <StatLabel>Pages</StatLabel>
            </StatCard>
            <StatCard
              $active={activeFilter === 'hierarchies'}
              onClick={() => handleStatClick('hierarchies')}
            >
              <StatValue>{hierarchyCount}</StatValue>
              <StatLabel>Hierarchies</StatLabel>
            </StatCard>
            <StatCard
              $active={activeFilter === 'graphql'}
              onClick={() => handleStatClick('graphql')}
            >
              <StatValue>{graphqlOps.length}</StatValue>
              <StatLabel>GraphQL</StatLabel>
            </StatCard>
            <StatCard
              $active={activeFilter === 'restapi'}
              onClick={() => handleStatClick('restapi')}
            >
              <StatValue>{apiCalls.length}</StatValue>
              <StatLabel>REST API</StatLabel>
            </StatCard>
          </StatsGrid>
        </Sidebar>

        <ContentArea>
          {viewMode === 'tree' && (
            <TreeView>
              {Object.entries(groupedPages).map(([group, pages]) => (
                <PageGroup key={group}>
                  <GroupHeader onClick={() => toggleGroup(group)}>
                    <span style={{ fontSize: '10px', color: theme.colors.textMuted }}>
                      {collapsedGroups.has(group) ? '▸' : '▾'}
                    </span>
                    <GroupName>/{group}</GroupName>
                    <GroupCount>{pages.length}</GroupCount>
                  </GroupHeader>
                  {!collapsedGroups.has(group) &&
                    pages.map((page) => {
                      const type = getPageType(page);
                      const queries =
                        page.dataFetching?.filter((d) => d.type === 'useQuery').length || 0;
                      const mutations =
                        page.dataFetching?.filter((d) => d.type === 'useMutation').length || 0;

                      return (
                        <PageItem
                          key={page.path}
                          $depth={page.depth}
                          $selected={selectedPage === page.path}
                          onClick={() => handlePageClick(page.path)}
                        >
                          <PageTypeTag $type={type}>{type}</PageTypeTag>
                          <PagePath>{page.path}</PagePath>
                          <PageMeta>
                            {page.authentication?.required && <Tag $variant="auth">AUTH</Tag>}
                            {queries > 0 && <Tag $variant="query">Q:{queries}</Tag>}
                            {mutations > 0 && <Tag $variant="mutation">M:{mutations}</Tag>}
                          </PageMeta>
                        </PageItem>
                      );
                    })}
                </PageGroup>
              ))}
            </TreeView>
          )}

          {viewMode === 'graph' && (
            <div style={{ padding: theme.spacing.md, color: theme.colors.textMuted }}>
              Graph view coming soon...
            </div>
          )}

          {/* Detail Panel */}
          <DetailPanel
            $open={!!selectedPageData || activeFilter === 'graphql' || activeFilter === 'restapi'}
          >
            <DetailHeader>
              <DetailTitle>
                {selectedPageData?.path ||
                  (activeFilter === 'graphql' ? 'GraphQL Operations' : 'REST API Calls')}
              </DetailTitle>
              <CloseButton onClick={closeDetail}>×</CloseButton>
            </DetailHeader>
            <DetailBody>
              {selectedPageData && (
                <>
                  <DetailSection>
                    <DetailSectionTitle>Info</DetailSectionTitle>
                    <DetailItem>
                      <DetailLabel>FILE</DetailLabel>
                      {selectedPageData.filePath}
                    </DetailItem>
                    <DetailItem>
                      <DetailLabel>AUTH</DetailLabel>
                      {selectedPageData.authentication?.required ? (
                        <Tag $variant="auth">LOGIN REQUIRED</Tag>
                      ) : (
                        'No auth required'
                      )}
                    </DetailItem>
                    {selectedPageData.layout && (
                      <DetailItem>
                        <DetailLabel>LAYOUT</DetailLabel>
                        {selectedPageData.layout}
                      </DetailItem>
                    )}
                    {selectedPageData.params && selectedPageData.params.length > 0 && (
                      <DetailItem>
                        <DetailLabel>PARAMS</DetailLabel>
                        {selectedPageData.params.map((p) => ':' + p).join(', ')}
                      </DetailItem>
                    )}
                  </DetailSection>

                  {selectedPageData.dataFetching && selectedPageData.dataFetching.length > 0 && (
                    <DetailSection>
                      <DetailSectionTitle>Data Operations</DetailSectionTitle>
                      {selectedPageData.dataFetching.map((df, i) => (
                        <DetailItem key={i}>
                          <Tag $variant={df.type === 'useMutation' ? 'mutation' : 'query'}>
                            {df.type === 'useMutation' ? 'MUTATION' : 'QUERY'}
                          </Tag>{' '}
                          {df.operationName}
                        </DetailItem>
                      ))}
                    </DetailSection>
                  )}
                </>
              )}

              {activeFilter === 'graphql' && (
                <DetailSection>
                  <DetailSectionTitle>
                    All GraphQL Operations ({graphqlOps.length})
                  </DetailSectionTitle>
                  {graphqlOps.slice(0, 30).map((op, i) => (
                    <DetailItem key={i}>
                      <Tag $variant={op.type === 'mutation' ? 'mutation' : 'query'}>
                        {op.type.toUpperCase()}
                      </Tag>{' '}
                      {op.name}
                    </DetailItem>
                  ))}
                  {graphqlOps.length > 30 && (
                    <div
                      style={{
                        color: theme.colors.textMuted,
                        fontSize: theme.fontSize.sm,
                        padding: theme.spacing.sm,
                      }}
                    >
                      ... and {graphqlOps.length - 30} more
                    </div>
                  )}
                </DetailSection>
              )}

              {activeFilter === 'restapi' && (
                <DetailSection>
                  <DetailSectionTitle>REST API Calls ({apiCalls.length})</DetailSectionTitle>
                  {apiCalls.map((api, i) => (
                    <DetailItem key={i}>
                      <Tag
                        style={{
                          background: api.method === 'GET' ? '#22c55e' : '#3b82f6',
                          color: 'white',
                        }}
                      >
                        {api.method}
                      </Tag>{' '}
                      <span style={{ fontFamily: 'monospace', fontSize: theme.fontSize.xs }}>
                        {api.url}
                      </span>
                      <div
                        style={{
                          fontSize: theme.fontSize.xs,
                          color: theme.colors.textMuted,
                          marginTop: 2,
                        }}
                      >
                        {api.callType} in {api.filePath}
                      </div>
                    </DetailItem>
                  ))}
                  {apiCalls.length === 0 && (
                    <div style={{ color: theme.colors.textMuted, fontSize: theme.fontSize.sm }}>
                      No REST API calls detected
                    </div>
                  )}
                </DetailSection>
              )}
            </DetailBody>
          </DetailPanel>
        </ContentArea>
      </MainContent>
    </Container>
  );
}
