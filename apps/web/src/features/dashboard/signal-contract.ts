export type SignalPlan = {
  status: string;
  direction: string;
  entry: number | string;
  stop: number | string;
  target: number | string;
};

export function immutableModuleSignalPlan(setup?: any, tradePlan?: any, trade?: any): SignalPlan | null {
  const planBelongsToSetup = !tradePlan?.setup_candidate_id || !setup?.id || tradePlan.setup_candidate_id === setup.id;
  const activePlan = Boolean(tradePlan?.active_trade_id);
  const setupStatus = String(setup?.status ?? "").toUpperCase();
  const setupExpiry = tradePlan?.setup_expires_at ?? setup?.expires_at;
  const setupNotExpired = !setupExpiry || new Date(setupExpiry).getTime() > Date.now();
  const setupReady = setupNotExpired && ["LONG SETUP READY", "SHORT SETUP READY", "TRADE_PLANNED", "PAPER_TRADE_OPENED"].includes(setupStatus);
  const activeTrade = trade?.outcome === "ACTIVE" || trade?.status === "ACTIVE";

  if (tradePlan?.active_trade_id && tradePlan?.actual_entry != null && tradePlan?.actual_stop != null && tradePlan?.actual_target != null) {
    const direction = tradePlan.direction;
    if (!validDirectionalSignalGeometry(direction, tradePlan.actual_entry, tradePlan.actual_stop, tradePlan.actual_target)) return null;
    return {
      status: "PAPER_TRADE_OPENED",
      direction,
      entry: tradePlan.actual_entry,
      stop: tradePlan.actual_stop,
      target: tradePlan.actual_target
    };
  }

  if ((activePlan || (planBelongsToSetup && setupReady)) && ["DRAFT", "READY", "EXECUTED"].includes(String(tradePlan?.status)) && tradePlan?.planned_entry != null && tradePlan?.planned_stop != null && tradePlan?.planned_target != null) {
    const direction = tradePlan.direction;
    if (!validDirectionalSignalGeometry(direction, tradePlan.planned_entry, tradePlan.planned_stop, tradePlan.planned_target)) return null;
    return {
      status: "TRADE_PLANNED",
      direction,
      entry: tradePlan.planned_entry,
      stop: tradePlan.planned_stop,
      target: tradePlan.planned_target
    };
  }

  if (activeTrade && trade?.actual_entry != null && trade?.actual_stop != null && trade?.actual_target != null) {
    const direction = trade.direction;
    if (!validDirectionalSignalGeometry(direction, trade.actual_entry, trade.actual_stop, trade.actual_target)) return null;
    return {
      status: "PAPER_TRADE_OPENED",
      direction,
      entry: trade.actual_entry,
      stop: trade.actual_stop,
      target: trade.actual_target
    };
  }

  if (setupReady && setup?.entry_price != null && setup?.stop_price != null && setup?.target_price != null) {
    const direction = setup.direction;
    if (!validDirectionalSignalGeometry(direction, setup.entry_price, setup.stop_price, setup.target_price)) return null;
    return {
      status: setup.status,
      direction,
      entry: setup.entry_price,
      stop: setup.stop_price,
      target: setup.target_price
    };
  }

  return null;
}

export function validDirectionalSignalGeometry(directionValue: unknown, entryValue: unknown, stopValue: unknown, targetValue: unknown) {
  const direction = String(directionValue ?? "").toUpperCase();
  const entry = Number(entryValue);
  const stop = Number(stopValue);
  const target = Number(targetValue);
  if (![entry, stop, target].every(Number.isFinite)) return false;
  if (["LONG", "BUY"].includes(direction)) return stop < entry && entry < target;
  if (["SHORT", "SELL"].includes(direction)) return target < entry && entry < stop;
  return false;
}
