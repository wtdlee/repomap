# repomap

Interactive documentation generator for code repositories. Visualize pages, components, GraphQL operations, and data flows with an intuitive web interface.

## Features

- 📄 **Page Analysis** - Automatically detect and document all pages with their routes, authentication requirements, and data dependencies
- 🔗 **GraphQL Mapping** - Extract and visualize all GraphQL queries, mutations, and fragments with field details
- 🧩 **Component Hierarchy** - Map component relationships and dependencies
- 🔄 **Data Flow Visualization** - Track how data flows through your application
- 🗺️ **Interactive Page Map** - Visual representation of your application structure
- 📊 **Mermaid Diagrams** - Auto-generated flowcharts and sequence diagrams
- 🔀 **Cross-Repository Analysis** - Analyze multiple repositories together to understand full-stack data flows

## Installation

```bash
npm install -g repomap
# or
npx repomap serve
```

## Quick Start

```bash
# Navigate to your project
cd my-nextjs-app

# Start the documentation server (no config needed!)
npx repomap serve

# Open http://localhost:3030
```

## Usage

### Basic Usage (No Config Required)

```bash
# Auto-detect project structure and start server
npx repomap serve

# Generate static documentation
npx repomap generate
```

### With Configuration

```bash
# Create a config file
npx repomap init

# Edit repomap.config.ts as needed

# Start server with config
npx repomap serve
```

### Multi-Repository Analysis

```typescript
// repomap.config.ts
export const config = {
  repositories: [
    {
      name: "frontend",
      path: "./frontend",
      type: "nextjs",
      // ...
    },
    {
      name: "backend",
      path: "./backend",
      type: "rails",
      // ...
    },
  ],
};
```

## Commands

| Command | Description |
|---------|-------------|
| `repomap serve` | Start interactive documentation server |
| `repomap generate` | Generate static documentation files |
| `repomap init` | Create configuration file |
| `repomap diff` | Show changes since last generation |

## Options

### serve

```bash
repomap serve [options]

Options:
  -c, --config <path>  Path to config file
  -p, --port <number>  Server port (default: 3030)
  --no-open            Don't open browser automatically
```

### generate

```bash
repomap generate [options]

Options:
  -c, --config <path>  Path to config file
  -o, --output <path>  Output directory
  --repo <name>        Analyze specific repository only
  --watch              Watch for changes and regenerate
```

## Configuration

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
      displayName: "My Project",
      description: "Main application",
      path: ".",
      branch: "main",
      type: "nextjs", // "nextjs" | "rails" | "generic"
      analyzers: ["pages", "graphql", "components", "dataflow"],
      settings: {
        pagesDir: "src/pages",
        featuresDir: "src/features",
        componentsDir: "src/components",
      },
    },
  ],
  analysis: {
    include: ["**/*.tsx", "**/*.ts"],
    exclude: ["**/node_modules/**", "**/__tests__/**"],
    maxDepth: 5,
  },
  diagrams: {
    enabled: true,
    types: ["flowchart", "sequence"],
    theme: "default",
  },
};

export default config;
```

## Supported Frameworks

- **Next.js** (Pages Router & App Router)
- **React** (with GraphQL)
- **Rails** (API analysis)
- **Generic** (TypeScript/JavaScript projects)

## Web Interface

The documentation server provides:

- **📋 Pages** - List of all pages with routes, auth requirements, and data operations
- **🧩 Components** - Component hierarchy and relationships
- **🔗 GraphQL** - All GraphQL operations with field details
- **🔄 Data Flow** - Visual data flow diagrams
- **🗺️ Page Map** - Interactive visual map of your application
- **📊 Diagrams** - Mermaid-generated architecture diagrams

## API

```typescript
import { DocGeneratorEngine, DocServer } from "repomap";

// Programmatic usage
const engine = new DocGeneratorEngine(config);
const report = await engine.generate();

// Start server
const server = new DocServer(config, 3030);
await server.start();
```

## License

MIT
