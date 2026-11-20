import { BadGatewayException, BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const SECRET_PATTERN = /(KEY|SECRET|PASS|TOKEN|PRIVATE)/i;

type ComposedStep = { toolId: string; purpose: string; config: Array<{ key: string; value: string }> };
type ComposedEdge = { from: number; to: number; mapping: Array<{ field: string; template: string }>; condition?: string };
type Composition = { name: string; description: string; explanation: string; steps: ComposedStep[]; edges: ComposedEdge[] };

@Injectable()
export class AiService {
  constructor(private prisma: PrismaService) {}

  private get model() {
    return process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
  }

  async gemini(prompt: string, schema: Record<string, any>): Promise<any> {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new ServiceUnavailableException('GEMINI_API_KEY is not configured');
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: schema },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new BadGatewayException(`Gemini returned ${res.status}`);
    const body: any = await res.json();
    const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new BadGatewayException('Gemini returned no content');
    return JSON.parse(text);
  }

  async composeWorkflow(request: string) {
    if (!request?.trim()) throw new BadRequestException('Describe what the workflow should do');

    const tools = await this.prisma.tool.findMany({
      where: { status: 'DEPLOYED' },
      select: { id: true, name: true, description: true, inputShape: true, outputShape: true, requiredEnv: true, usagePrice: true, rating: true },
    });
    if (!tools.length) throw new BadRequestException('No deployed tools are available yet');

    const catalog = tools.map(t => ({
      toolId: t.id,
      name: t.name,
      description: t.description,
      input: t.inputShape,
      output: t.outputShape,
      config: t.requiredEnv.filter(k => !SECRET_PATTERN.test(k)),
      priceHbar: t.usagePrice,
      rating: t.rating,
    }));

    const prompt = [
      'You design workflows for AgentHive, a marketplace of containerized AI tools paid in HBAR on Hedera.',
      'Build the smallest workflow that satisfies the request using only tools from the catalog.',
      'Steps run in order of the edges. The first step receives the user input as is.',
      'Each edge maps fields of the next tool input to templates. A template uses {{field}} to read a field from the previous step output or input, for example {"field":"text","template":"{{text}}"}.',
      'An edge may have a JavaScript-like condition over the previous output, for example closest_category == "billing". Leave it empty when not needed.',
      'Fill config values only for the listed config keys, for example a target language code or a comma separated list of categories.',
      'Prefer higher rated and cheaper tools when two tools do the same job.',
      `Catalog: ${JSON.stringify(catalog)}`,
      `Request: ${request.trim()}`,
    ].join('\n');

    const schema = {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING' },
        description: { type: 'STRING' },
        explanation: { type: 'STRING' },
        steps: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              toolId: { type: 'STRING', enum: tools.map(t => t.id) },
              purpose: { type: 'STRING' },
              config: {
                type: 'ARRAY',
                items: { type: 'OBJECT', properties: { key: { type: 'STRING' }, value: { type: 'STRING' } }, required: ['key', 'value'] },
              },
            },
            required: ['toolId', 'purpose', 'config'],
          },
        },
        edges: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              from: { type: 'INTEGER' },
              to: { type: 'INTEGER' },
              mapping: {
                type: 'ARRAY',
                items: { type: 'OBJECT', properties: { field: { type: 'STRING' }, template: { type: 'STRING' } }, required: ['field', 'template'] },
              },
              condition: { type: 'STRING' },
            },
            required: ['from', 'to', 'mapping'],
          },
        },
      },
      required: ['name', 'description', 'explanation', 'steps', 'edges'],
    };

    const plan: Composition = await this.gemini(prompt, schema);
    return this.toGraph(plan, tools);
  }

  private toGraph(plan: Composition, tools: Array<{ id: string; name: string; requiredEnv: string[]; usagePrice: number }>) {
    const toolById = new Map(tools.map(t => [t.id, t]));
    const steps = (plan.steps ?? []).filter(s => toolById.has(s.toolId));
    if (!steps.length) throw new BadGatewayException('The model did not pick any known tool, try rephrasing');

    const nodes = steps.map((s, i) => {
      const tool = toolById.get(s.toolId)!;
      const config = Object.fromEntries((s.config ?? []).map(c => [c.key, c.value]));
      const env = Object.fromEntries(
        tool.requiredEnv.map(k => [k, SECRET_PATTERN.test(k) ? '' : String(config[k] ?? '')]),
      );
      return { id: `node_${i + 1}`, name: tool.name, toolId: tool.id, purpose: s.purpose, env };
    });

    const edges = (plan.edges ?? [])
      .filter(e => e.from >= 0 && e.to >= 0 && e.from < nodes.length && e.to < nodes.length && e.from !== e.to)
      .map(e => ({
        from: nodes[e.from].id,
        to: nodes[e.to].id,
        mapping: Object.fromEntries((e.mapping ?? []).map(m => [m.field, m.template])),
        condition: e.condition?.trim() || undefined,
      }));
    if (!edges.length && nodes.length > 1) {
      for (let i = 1; i < nodes.length; i++) edges.push({ from: nodes[i - 1].id, to: nodes[i].id, mapping: { text: '{{text}}' }, condition: undefined });
    }

    const secretsNeeded = nodes.flatMap(n => Object.keys(n.env).filter(k => SECRET_PATTERN.test(k)).map(k => ({ node: n.id, key: k })));
    const estimatedCostHbar = steps.reduce((sum, s) => sum + (toolById.get(s.toolId)?.usagePrice ?? 0), 0);

    return {
      name: plan.name,
      description: plan.description,
      explanation: plan.explanation,
      graphJson: { nodes, edges },
      secretsNeeded,
      estimatedCostHbar,
      model: this.model,
    };
  }
}
