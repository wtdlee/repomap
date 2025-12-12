# repomap

Interactive documentation generator for code repositories. Visualize pages, components, routes, and data flows with an intuitive web interface.

## Features

### 🗺️ Page Map
- **Multi-framework support** - Next.js (Pages/App Router), React, Rails
- **Interactive graph view** - Visual representation of page relationships
- **Route analysis** - Automatic detection of routes, authentication, and data dependencies
- **React component tracking** - Detect React components used in Rails views

### 🛤️ Rails Map
- **Routes explorer** - Browse all routes with method, path, controller info
- **Controllers view** - List controllers with actions, filters, and inheritance
- **Models view** - View models with associations, validations, and scopes
- **gRPC services** - Browse gRPC services with RPC methods
- **Model Relationships diagram** - Auto-generated ER diagram using Mermaid
- **Advanced filtering** - Filter by namespace, HTTP methods (multi-select with Ctrl/Cmd)
- **Search** - Full-text search across routes, controllers, models

### 🔗 GraphQL Analysis
- **Operations mapping** - Extract queries, mutations, and fragments
- **Field details** - View all fields with types and arguments
- **Usage tracking** - See where operations are used

### 📊 Data Flow
- **Visual diagrams** - Mermaid-generated flowcharts
- **Cross-component tracking** - Follow data through your application
- **REST API detection** - Automatic API endpoint discovery

## Screenshots

| Page Map | Rails Map |
|----------|-----------|
| Interactive page visualization | Routes, Controllers, Models, gRPC |

## Installation

```bash
npm install -g repomap
# or
pnpm add -g repomap
# or use directly
npx repomap serve
```

## Quick Start

```bash
# Navigate to your project
cd my-project

# Start the documentation server (no config needed!)
npx repomap serve

# Open http://localhost:3030
```

### Options

```bash
npx repomap serve [options]

Options:
  -p, --port <number>  Server port (default: 3030)
  -c, --config <path>  Path to config file
  --no-cache           Disable caching
  --no-open            Don't open browser automatically
```

## Web Interface

### `/page-map` - Page Map
- **Tree View**: Hierarchical list of all pages grouped by framework/directory
- **Graph View**: Interactive force-directed graph visualization
- **Rails Routes**: Browse routes with response type indicators (JSON, HTML, Redirect)
- **Rails Screens**: View-based screen listing with template info
- **React Components**: React components used in Rails views with usage locations

#### Route Indicators
| Tag | Meaning |
|-----|---------|
| `JSON` | Returns JSON response |
| `HTML` | Returns HTML response |
| `→` | Redirects to another path |
| `View` | Has associated view template |
| `Svc` | Uses service objects |
| `gRPC` | Makes gRPC calls |
| `DB` | Accesses database models |

### `/rails-map` - Rails Map
- **Routes Tab**: All routes with filtering and search
- **Controllers Tab**: Controllers with actions and filters
- **Models Tab**: Models with associations and validations
- **gRPC Tab**: gRPC services with RPC methods
- **Diagram Tab**: Model relationships ER diagram

#### Features
- Multi-select filters (Ctrl/Cmd + click)
- URL state persistence (refresh preserves filters)
- Show more pagination (200 items at a time)
- Search includes hidden items

### `/docs` - Documentation
- Auto-generated markdown documentation
- Navigation sidebar
- Syntax-highlighted code blocks

## Supported Frameworks

| Framework | Features |
|-----------|----------|
| **Next.js** | Pages Router, App Router, API routes, data fetching |
| **React** | Components, GraphQL operations, hooks |
| **Rails** | Routes, Controllers, Models, Views, gRPC, React integration |

## Rails Analysis Details

### Routes Analysis
- Parse `config/routes.rb` with nested resources
- Extract HTTP method, path, controller, action
- Detect namespaces and constraints

### Controller Analysis
- Actions with visibility (public/private/protected)
- Before/after filters
- Response types (JSON, HTML, redirect)
- Service and model calls
- Instance variable assignments

### View Analysis
- HAML, ERB, YML templates
- Partial usage
- Helper calls
- Instance variables
- React component detection (`render_react_component`, `data-react-component`)

### Model Analysis
- Associations (belongs_to, has_many, has_one)
- Validations
- Scopes
- Callbacks

### gRPC Analysis
- Service definitions
- RPC methods with request/response types
- Namespace organization

## Configuration (Optional)

```typescript
// repomap.config.ts
import type { DocGeneratorConfig } from "repomap";

export const config: DocGeneratorConfig = {
  outputDir: "./.repomap",
  site: {
    title: "My Project Documentation",
    description: "Auto-generated documentation",
    baseUrl: "/docs",
  },
  repositories: [
    {
      name: "my-project",
      path: ".",
      type: "nextjs", // "nextjs" | "rails" | "generic"
      analyzers: ["pages", "graphql", "components", "dataflow"],
    },
  ],
  analysis: {
    include: ["**/*.tsx", "**/*.ts", "**/*.rb"],
    exclude: ["**/node_modules/**", "**/vendor/**"],
  },
};

export default config;
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `repomap serve` | Start interactive documentation server |
| `repomap generate` | Generate static documentation files |
| `repomap init` | Create configuration file |

## API Usage

```typescript
import { DocGeneratorEngine, DocServer } from "repomap";

// Programmatic usage
const engine = new DocGeneratorEngine(config);
const report = await engine.generate();

// Start server
const server = new DocServer(config, 3030);
await server.start();
```

## Project Structure

```
src/
├── analyzers/
│   ├── pages-analyzer.ts      # Page/route analysis
│   ├── graphql-analyzer.ts    # GraphQL operations
│   ├── rest-api-analyzer.ts   # REST API detection
│   ├── dataflow-analyzer.ts   # Data flow tracking
│   └── rails/
│       ├── rails-routes-analyzer.ts
│       ├── rails-controller-analyzer.ts
│       ├── rails-model-analyzer.ts
│       ├── rails-view-analyzer.ts
│       ├── rails-grpc-analyzer.ts
│       └── rails-react-analyzer.ts
├── generators/
│   ├── page-map-generator.ts  # Page map HTML generation
│   ├── rails-map-generator.ts # Rails map HTML generation
│   ├── markdown-generator.ts  # Markdown docs
│   └── mermaid-generator.ts   # Diagram generation
├── server/
│   └── doc-server.ts          # Express server
└── core/
    └── engine.ts              # Main engine
```

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Run locally
pnpm dev:serve

# Format code
pnpm format

# Lint
pnpm lint
```

## License

MIT
