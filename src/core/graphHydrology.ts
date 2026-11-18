import {
  AnomalyEvent,
  HydraulicNetworkSummary,
  MassBalanceReport,
  NetworkNode,
  PipeSegment,
  PropagatedNodeRisk,
} from './types';

export function getUpstreamNodeIds(nodeId: string, pipes: PipeSegment[]): string[] {
  return pipes.filter((p) => p.to === nodeId).map((p) => p.from);
}

export function getDownstreamNodeIds(startNodeId: string, pipes: PipeSegment[]): string[] {
  const visited = new Set<string>();
  const queue: string[] = [startNodeId];
  const ordered: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const pipe of pipes) {
      if (pipe.from === current && !visited.has(pipe.to)) {
        visited.add(pipe.to);
        ordered.push(pipe.to);
        queue.push(pipe.to);
      }
    }
  }

  return ordered;
}

export function evaluatePipeMassBalances(
  nodes: NetworkNode[],
  pipes: PipeSegment[]
): MassBalanceReport[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const reports: MassBalanceReport[] = [];

  for (const node of nodes) {
    const outgoing = pipes.filter((p) => p.from === node.id);
    if (outgoing.length === 0) continue;

    const children = outgoing
      .map((p) => nodeMap.get(p.to))
      .filter((n): n is NetworkNode => Boolean(n));
    if (children.length === 0) continue;

    const inflowLs = node.current.flowLs;
    const outflowSumLs = Number(
      children.reduce((acc, c) => acc + c.current.flowLs, 0).toFixed(2)
    );
    const baselineOutflow = children.reduce((acc, c) => acc + c.baseline.flowLs, 0);
    const baselineResidualLs = Number((node.baseline.flowLs - baselineOutflow).toFixed(2));
    const currentResidualLs = Number((inflowLs - outflowSumLs).toFixed(2));
    const deviationLs = Number((currentResidualLs - baselineResidualLs).toFixed(2));
    const imbalancePct = Number(
      ((Math.abs(deviationLs) / Math.max(1, node.baseline.flowLs)) * 100).toFixed(1)
    );

    const flagged = Math.abs(deviationLs) >= 4.0 && imbalancePct >= 15;

    reports.push({
      nodeId: node.id,
      nodeName: node.name,
      inflowLs,
      outflowSumLs,
      baselineResidualLs,
      currentResidualLs,
      deviationLs,
      imbalancePct,
      flagged,
    });
  }

  return reports;
}

export function analyzeNetworkHydraulics(
  nodes: NetworkNode[],
  pipes: PipeSegment[],
  anomalies: AnomalyEvent[]
): HydraulicNetworkSummary {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const massBalances = evaluatePipeMassBalances(nodes, pipes);
  const activeAnomalies = anomalies.filter((a) => a.status === 'active');

  const propagatedByNode: Record<string, PropagatedNodeRisk> = {};
  const affectedPipeIds = new Set<string>();
  const affectedNodeIds = new Set<string>();

  for (const anom of activeAnomalies) {
    affectedNodeIds.add(anom.nodeId);

    // Sensor faults represent instrumentation errors, not physical downstream water crises
    if (anom.category === 'sensor_fault') {
      continue;
    }

    const impactLevel: 'high' | 'moderate' =
      anom.category === 'leak' || anom.category === 'contamination' ? 'high' : 'moderate';
    const downstreamIds = getDownstreamNodeIds(anom.nodeId, pipes);

    for (const pipe of pipes) {
      if (
        (pipe.from === anom.nodeId || downstreamIds.includes(pipe.from)) &&
        downstreamIds.includes(pipe.to)
      ) {
        affectedPipeIds.add(pipe.id);
      }
    }

    for (const targetId of downstreamIds) {
      affectedNodeIds.add(targetId);
      const existing = propagatedByNode[targetId];
      if (!existing || (existing.impactLevel === 'moderate' && impactLevel === 'high')) {
        propagatedByNode[targetId] = {
          nodeId: targetId,
          sourceNodeId: anom.nodeId,
          sourceNodeName: anom.nodeName,
          sourceCategory: anom.category,
          impactLevel,
          reason:
            anom.category === 'contamination'
              ? `Riesgo sanitario propagado aguas abajo desde ${anom.nodeName}`
              : anom.category === 'leak'
                ? `Caída de presión/servicio propagada desde fuga en ${anom.nodeName}`
                : anom.category === 'obstruction'
                  ? `Déficit de caudal aguas abajo por estrangulamiento en ${anom.nodeName}`
                  : `Deriva de calidad propagada desde ${anom.nodeName}`,
        };
      }
    }
  }

  // Also highlight pipes attached to flagged mass-balance nodes
  for (const mb of massBalances) {
    if (mb.flagged) {
      for (const pipe of pipes) {
        if (pipe.from === mb.nodeId || pipe.to === mb.nodeId) {
          affectedPipeIds.add(pipe.id);
        }
      }
    }
  }

  // Deduplicated affected population: main backbone nodes serve up to 4800 total network population
  const affectedNodes = Array.from(affectedNodeIds)
    .map((id) => nodeMap.get(id))
    .filter((n): n is NetworkNode => Boolean(n));

  let totalAffectedPopulation = 0;
  if (affectedNodes.length > 0) {
    const maxNetworkCap = Math.max(...nodes.map((n) => n.populationServed), 4800);
    const hasBackbone = affectedNodes.some((n) => n.populationServed >= maxNetworkCap);
    if (hasBackbone) {
      totalAffectedPopulation = maxNetworkCap;
    } else {
      // Sum leaf/branch populations only for affected nodes that don't overlap a selected parent in the same branch
      const rawSum = affectedNodes.reduce((acc, n) => acc + n.populationServed, 0);
      totalAffectedPopulation = Math.min(maxNetworkCap, rawSum);
    }
  }

  return {
    massBalances,
    propagatedByNode,
    affectedPipeIds: Array.from(affectedPipeIds),
    totalAffectedPopulation,
  };
}

export function enrichAnomalyWithNetworkContext(
  anomaly: AnomalyEvent,
  nodes: NetworkNode[],
  pipes: PipeSegment[]
): AnomalyEvent {
  const upstreamIds = getUpstreamNodeIds(anomaly.nodeId, pipes);
  const downstreamIds =
    anomaly.category === 'sensor_fault' ? [] : getDownstreamNodeIds(anomaly.nodeId, pipes);
  const massBalances = evaluatePipeMassBalances(nodes, pipes);

  const relevantBalance =
    massBalances.find((m) => m.nodeId === anomaly.nodeId && m.flagged) ??
    massBalances.find((m) => upstreamIds.includes(m.nodeId) && m.flagged);

  const rules = [...anomaly.rulesTriggered];
  if (relevantBalance && !rules.some((r) => r.ruleId === 'HYDRAULIC_MASS_IMBALANCE')) {
    rules.push({
      ruleId: 'HYDRAULIC_MASS_IMBALANCE',
      title: `Desbalance de masa en grafo hidráulico (${relevantBalance.nodeName})`,
      category: anomaly.category,
      severityScore: Math.min(90, Math.round(45 + relevantBalance.imbalancePct)),
      metric: 'massBalanceLs',
      observedValue: relevantBalance.currentResidualLs,
      baselineValue: relevantBalance.baselineResidualLs,
      deltaPct: relevantBalance.imbalancePct,
      explanation: `Balance nodal en ${relevantBalance.nodeName}: entrada ${relevantBalance.inflowLs} L/s vs salida aguas abajo ${relevantBalance.outflowSumLs} L/s (desviación ${relevantBalance.deviationLs >= 0 ? `+${relevantBalance.deviationLs}` : relevantBalance.deviationLs} L/s, ${relevantBalance.imbalancePct}%).`,
    });
  }

  const summary = analyzeNetworkHydraulics(nodes, pipes, [{ ...anomaly, rulesTriggered: rules }]);

  return {
    ...anomaly,
    rulesTriggered: rules,
    correlatedUpstreamNodeId: upstreamIds[0],
    downstreamAffectedNodeIds: downstreamIds,
    downstreamPopulationAffected: summary.totalAffectedPopulation,
    massBalanceDeltaLs: relevantBalance?.deviationLs,
  };
}

