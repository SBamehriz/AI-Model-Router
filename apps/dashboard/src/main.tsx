import { StrictMode, Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { ThemeProvider } from 'next-themes';
import { ChromeColor } from './components/common/ChromeColor';
import { router } from './router';
import './index.css';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="mx-auto max-w-xl p-8">
          <h1 className="text-lg font-semibold text-destructive">Something went wrong</h1>
          <pre className="mt-4 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-4 text-sm">
            {this.state.error.message}
          </pre>
          <p className="mt-4 text-sm text-muted-foreground">
            If the API is not running, start it with <code>npm run dev:api</code> from the repository
            root.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <ThemeProvider attribute="class" storageKey="ai-model-router.theme" defaultTheme="system" enableSystem>
        <ChromeColor />
        <RouterProvider router={router} />
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>
);
