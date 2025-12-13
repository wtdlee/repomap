/**
 * Environment detection utilities
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export type EnvironmentType = 'nextjs' | 'react' | 'rails' | 'generic';

export interface DetectedEnvironment {
  type: EnvironmentType;
  detected: boolean;
  version?: string;
  path: string;
  features: string[];
}

export interface EnvironmentDetectionResult {
  environments: DetectedEnvironment[];
  hasNextjs: boolean;
  hasReact: boolean;
  hasRails: boolean;
  primary: EnvironmentType;
}

/**
 * Detect all environments in the given directory
 */
export async function detectEnvironments(rootPath: string): Promise<EnvironmentDetectionResult> {
  const environments: DetectedEnvironment[] = [];

  // Check for Rails
  const railsEnv = await detectRails(rootPath);
  if (railsEnv.detected) {
    environments.push(railsEnv);
  }

  // Check for Next.js / React
  const jsEnv = await detectJsEnvironment(rootPath);
  if (jsEnv.detected) {
    environments.push(jsEnv);
  }

  const hasNextjs = environments.some((e) => e.type === 'nextjs');
  const hasReact = environments.some((e) => e.type === 'react' || e.type === 'nextjs');
  const hasRails = environments.some((e) => e.type === 'rails');

  // Determine primary environment
  let primary: EnvironmentType = 'generic';
  if (hasNextjs) {
    primary = 'nextjs';
  } else if (hasReact) {
    primary = 'react';
  } else if (hasRails) {
    primary = 'rails';
  }

  return {
    environments,
    hasNextjs,
    hasReact,
    hasRails,
    primary,
  };
}

/**
 * Detect Rails environment
 */
async function detectRails(rootPath: string): Promise<DetectedEnvironment> {
  const result: DetectedEnvironment = {
    type: 'rails',
    detected: false,
    path: rootPath,
    features: [],
  };

  try {
    const gemfilePath = path.join(rootPath, 'Gemfile');
    const routesPath = path.join(rootPath, 'config', 'routes.rb');

    // Check for Gemfile
    await fs.access(gemfilePath);
    await fs.access(routesPath);

    const gemfile = await fs.readFile(gemfilePath, 'utf-8');
    const isRails = gemfile.includes("gem 'rails'") || gemfile.includes('gem "rails"');

    if (!isRails) {
      return result;
    }

    result.detected = true;

    // Extract Rails version
    const versionMatch = gemfile.match(/gem ['"]rails['"],\s*['"]([^'"]+)['"]/);
    if (versionMatch) {
      result.version = versionMatch[1];
    }

    // Detect features
    const features: string[] = [];

    // Check for gRPC services
    try {
      await fs.access(path.join(rootPath, 'app', 'grpc_services'));
      features.push('grpc');
    } catch {}

    // Check for API mode
    try {
      const appConfig = await fs.readFile(path.join(rootPath, 'config', 'application.rb'), 'utf-8');
      if (appConfig.includes('config.api_only = true')) {
        features.push('api-only');
      }
    } catch {}

    // Check for GraphQL
    if (gemfile.includes("gem 'graphql'") || gemfile.includes('gem "graphql"')) {
      features.push('graphql');
    }

    // Check for Devise
    if (gemfile.includes("gem 'devise'") || gemfile.includes('gem "devise"')) {
      features.push('devise');
    }

    result.features = features;
  } catch {
    // Not a Rails project
  }

  return result;
}

/**
 * Detect JavaScript environment (Next.js or React)
 */
async function detectJsEnvironment(rootPath: string): Promise<DetectedEnvironment> {
  const result: DetectedEnvironment = {
    type: 'react',
    detected: false,
    path: rootPath,
    features: [],
  };

  try {
    const packageJsonPath = path.join(rootPath, 'package.json');
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

    // Check for React
    if (!deps['react']) {
      return result;
    }

    result.detected = true;
    result.version = deps['react'];

    const features: string[] = [];

    // Check for Next.js
    if (deps['next']) {
      result.type = 'nextjs';
      result.version = deps['next'];

      // Check for App Router vs Pages Router
      try {
        await fs.access(path.join(rootPath, 'app'));
        features.push('app-router');
      } catch {}

      try {
        await fs.access(path.join(rootPath, 'pages'));
        features.push('pages-router');
      } catch {}

      try {
        await fs.access(path.join(rootPath, 'src', 'pages'));
        features.push('pages-router');
      } catch {}

      try {
        await fs.access(path.join(rootPath, 'src', 'app'));
        features.push('app-router');
      } catch {}
    }

    // Check for GraphQL
    if (deps['@apollo/client'] || deps['graphql'] || deps['graphql-request'] || deps['urql']) {
      features.push('graphql');
    }

    // Check for TypeScript
    if (deps['typescript']) {
      features.push('typescript');
    }

    // Check for state management
    if (deps['redux'] || deps['@reduxjs/toolkit']) {
      features.push('redux');
    }
    if (deps['zustand']) {
      features.push('zustand');
    }
    if (deps['jotai'] || deps['recoil']) {
      features.push('atomic-state');
    }

    result.features = features;
  } catch {
    // Not a JS project
  }

  return result;
}

/**
 * Get analyzer types for detected environments
 */
export function getAnalyzersForEnvironments(envResult: EnvironmentDetectionResult): {
  frontend: string[];
  backend: string[];
} {
  const frontend: string[] = [];
  const backend: string[] = [];

  if (envResult.hasNextjs || envResult.hasReact) {
    frontend.push('pages', 'graphql', 'dataflow', 'rest-api');
  }

  if (envResult.hasRails) {
    backend.push('routes', 'controllers', 'models', 'grpc');
  }

  return { frontend, backend };
}
