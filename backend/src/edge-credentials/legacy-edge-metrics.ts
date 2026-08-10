import { Injectable } from '@nestjs/common';

@Injectable()
export class LegacyEdgeMetrics {
  private readonly routeCounts = new Map<string, number>();

  increment(route: string): void {
    this.routeCounts.set(route, (this.routeCounts.get(route) ?? 0) + 1);
  }

  count(route: string): number {
    return this.routeCounts.get(route) ?? 0;
  }
}
