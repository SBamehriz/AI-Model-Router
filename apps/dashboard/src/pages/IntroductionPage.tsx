import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, BookOpen, Check, Code2, KeyRound, Layers3, Plug, Route } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RouterLogo } from '@/components/ui/router-logo';

const preferences = [
  { id: 'auto-cheap', label: 'Spend less', title: 'Give cost more weight.', description: 'Favor lower estimated cost among models that meet the task requirements.', icon: Layers3 },
  { id: 'auto', label: 'Find a balance', title: 'Balance the tradeoffs.', description: 'Weigh estimated cost, latency, and task fit. Difficult prompts shift the balance toward capability.', icon: Route },
  { id: 'auto-best', label: 'Prioritize quality', title: 'Give capability more weight.', description: 'Favor quality estimates and task fit while still considering cost and latency.', icon: Check },
];

export function IntroductionPage() {
  const [selected, setSelected] = useState(1);
  const preference = preferences[selected];
  return <div className="intro-page">
    <section className="intro-hero" aria-labelledby="intro-title">
      <div className="intro-copy">
        <p className="eyebrow">Your models. One connection.</p>
        <h1 id="intro-title">AI Model<br /><span className="brand-wordmark">Router.</span></h1>
        <p className="intro-lead">Let the request<br className="hidden xl:block" /> choose the model.</p>
        <p className="intro-description">Connect your providers once. Send requests from your apps. See how each model was chosen and what the response cost.</p>
        <div className="mt-7 flex flex-wrap gap-3"><Button asChild><Link to="/settings">Set up your router<ArrowRight aria-hidden="true" /></Link></Button><Button asChild variant="ghost"><Link to="/playground">Try a prompt<ArrowRight aria-hidden="true" /></Link></Button></div>
        <p className="mt-5 text-xs leading-6 text-muted-foreground">Runs on your machine. Try it without provider keys.</p>
      </div>
      <div className="routing-scene" aria-label="Interactive illustration of routing preferences">
        <div className="scene-heading"><span className="eyebrow">Follow a request</span><span className="text-xs text-muted-foreground">Illustration</span></div>
        <div className="scene-request"><Code2 className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" /><div><p className="text-xs text-muted-foreground">From your app</p><p className="mt-1 text-sm font-medium">Explain this function in plain language.</p></div></div>
        <div className="scene-stem" aria-hidden="true"><span /></div>
        <div className="scene-router"><RouterLogo className="h-11 w-11 shrink-0" /><div><p className="text-sm font-semibold">Understand. Rank. Route.</p><p className="mt-1 text-xs text-muted-foreground">Task, difficulty, and available models.</p></div></div>
        <div className="scene-branches" aria-hidden="true"><svg viewBox="0 0 600 88" preserveAspectRatio="none"><defs><linearGradient id="route-trace" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" /><stop offset="100%" /></linearGradient></defs><path d="M300 0 V28 Q300 38 290 38 H110 Q100 38 100 48 V88 M300 38 V88 M300 38 H490 Q500 38 500 48 V88" /><path key={selected} className="scene-active-path" d={selected === 0 ? 'M300 0 V28 Q300 38 290 38 H110 Q100 38 100 48 V88' : selected === 1 ? 'M300 0 V88' : 'M300 0 V28 Q300 38 310 38 H490 Q500 38 500 48 V88'} /></svg></div>
        <div className="scene-priorities" role="group" aria-label="Explore routing preferences">{preferences.map((item, index) => <button key={item.id} type="button" aria-pressed={selected === index} aria-controls="preference-explanation" onClick={() => setSelected(index)}><item.icon className="h-5 w-5" aria-hidden="true" /><span>{item.label}</span><code>{item.id}</code></button>)}</div>
        <div id="preference-explanation" className="scene-explanation" aria-live="polite" aria-atomic="true"><p className="text-sm font-semibold">{preference.title}</p><p className="mt-2 text-sm leading-6 text-muted-foreground">{preference.description}</p></div>
        <div className="scene-return"><Check className="h-4 w-4 text-primary" aria-hidden="true" /><span>One response, with a route you can inspect.</span></div>
        <p className="mt-4 text-center text-xs leading-5 text-muted-foreground">Change a preference to explore. No request is sent.</p>
      </div>
    </section>
    <section className="intro-explainer" aria-label="What the router does"><div><span className="eyebrow">Behind the connection</span><h2>A choice you can understand.</h2></div><p>The router filters models by capability and context, ranks the candidates, and calls a provider. When a call fails, it can try another model. Open Requests to see the selected route, token usage, and outcome.</p></section>
    <section className="intro-setup" aria-labelledby="setup-heading"><div className="mb-7 flex flex-wrap items-center justify-between gap-3"><h2 id="setup-heading" className="text-xl font-semibold tracking-tight">From your first key to your first response.</h2><Link className="subtle-link" to="/guide">Open the user guide<BookOpen className="h-4 w-4" aria-hidden="true" /></Link></div><ol className="grid gap-7 md:grid-cols-3">{[
      { icon: KeyRound, title: 'Connect your providers', text: 'Add a built in provider or your own compatible API. Provider keys stay encrypted on the server.', href: '/guide?topic=providers', link: 'Provider setup' },
      { icon: Plug, title: 'Give your app a router key', text: 'Create a separate key for each app. Use the same endpoint for OpenClaw, scripts, and other compatible clients.', href: '/guide?topic=apps', link: 'Connect an app' },
      { icon: Check, title: 'Run it and inspect it', text: 'Test a prompt, check the recorded request, and verify streaming and tools before connecting an agent.', href: '/guide?topic=testing', link: 'Verify a connection' },
    ].map((step, index) => <li key={step.title} className="intro-setup-step"><div className="mb-5 flex items-center justify-between"><step.icon className="h-5 w-5 text-primary" aria-hidden="true" /><span className="font-mono text-xs text-muted-foreground">0{index + 1}</span></div><h3 className="text-sm font-semibold">{step.title}</h3><p className="mt-2 text-sm leading-7 text-muted-foreground">{step.text}</p><Link to={step.href} className="subtle-link mt-3">{step.link}<ArrowRight className="h-4 w-4" aria-hidden="true" /></Link></li>)}</ol></section>
    <p className="intro-footnote">Text and function tools are supported. Provider specific APIs and account access still need to be verified.</p>
  </div>;
}
