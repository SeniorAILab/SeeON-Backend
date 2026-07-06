import * as fs from 'fs';
import * as path from 'path';
import { AlertEventTypes } from '../src/alerts/dto/alert-events.dto';

describe('AlertEventType cross-language contract', () => {
  it('keeps the TS AlertEventTypes values in sync with the Python AlertEventType Literal', () => {
    const relayPath = path.join(
      __dirname,
      '..',
      '..',
      'ml',
      'contracts',
      'relay.py',
    );
    const source = fs.readFileSync(relayPath, 'utf8');

    const literalMatch = source.match(
      /AlertEventType:\s*TypeAlias\s*=\s*Literal\[([^\]]+)\]/,
    );
    if (!literalMatch) {
      throw new Error(
        `Could not find "AlertEventType: TypeAlias = Literal[...]" in ${relayPath}`,
      );
    }

    const pythonValues = Array.from(
      literalMatch[1].matchAll(/["']([^"']+)["']/g),
    ).map((match) => match[1]);
    expect(pythonValues.length).toBeGreaterThan(0);

    const tsValues = Object.values(AlertEventTypes);

    expect(new Set(pythonValues)).toEqual(new Set(tsValues));
  });
});
