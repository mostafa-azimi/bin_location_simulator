"use client";

import { ChangeEvent, useEffect, useMemo, useState } from "react";

type RouteSide = "left" | "right";
type PageKey = "create" | "overhead" | "aisle" | "output";
type SourceMode = "generated" | "uploaded";

type LayoutConfig = {
  zones: number;
  aisles: number;
  bays: number;
  shelves: number;
  slots: number;
};

type LocationRecord = {
  name: string;
  zoneLabel: string;
  zoneIndex: number;
  aisleLabel: string;
  aisle: number;
  bay: number;
  shelfLabel: string;
  shelfIndex: number;
  slot: number;
  side: RouteSide;
  originalIndex: number;
  zeroPadded: boolean;
  usesTargetPrefix: boolean;
};

type UploadAnalysis = {
  fileName: string;
  totalRows: number;
  validLocations: LocationRecord[];
  invalidNames: string[];
  duplicateNames: string[];
  nonPaddedNames: string[];
  legacyPrefixNames: string[];
  routeBacktracks: string[];
  inferredConfig: LayoutConfig;
};

const defaultConfig: LayoutConfig = {
  zones: 1,
  aisles: 3,
  bays: 8,
  shelves: 3,
  slots: 4,
};

const inputLimits: Record<keyof LayoutConfig, number> = {
  zones: 6,
  aisles: 24,
  bays: 48,
  shelves: 8,
  slots: 12,
};

const labels: Record<keyof LayoutConfig, string> = {
  zones: "Zones",
  aisles: "Aisles",
  bays: "Bays per aisle",
  shelves: "Shelves per bay",
  slots: "Slots per shelf",
};

const pageLabels: Array<{ key: PageKey; label: string }> = [
  { key: "create", label: "Create" },
  { key: "overhead", label: "Overhead" },
  { key: "aisle", label: "Aisle" },
  { key: "output", label: "Output" },
];

const alphaSort = (a: string, b: string) =>
  a.localeCompare(b, "en-US", { numeric: false, sensitivity: "base" });

const clampNumber = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Number.isFinite(value) ? Math.floor(value) : min));

const pad2 = (value: number) => String(value).padStart(2, "0");

function lettersFromNumber(value: number) {
  let n = value;
  let label = "";

  while (n > 0) {
    n -= 1;
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26);
  }

  return label || "A";
}

function numberFromLetters(value: string) {
  return value
    .toUpperCase()
    .split("")
    .reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0);
}

function locationName(
  zoneIndex: number,
  aisle: number,
  bay: number,
  shelfIndex: number,
  slot: number,
) {
  return `${pad2(zoneIndex)}${lettersFromNumber(aisle)}-${pad2(
    bay,
  )}-${lettersFromNumber(shelfIndex)}-${pad2(slot)}`;
}

function parseLocationName(name: string, originalIndex: number): LocationRecord | null {
  const cleanName = name.trim();
  const targetMatch = /^(\d+)([A-Za-z]+)-(\d+)-([A-Za-z]+)-(\d+)$/.exec(cleanName);
  const legacyMatch = /^([A-Za-z]+)(\d+)-(\d+)-([A-Za-z]+)-(\d+)$/.exec(cleanName);

  if (!targetMatch && !legacyMatch) {
    return null;
  }

  const usesTargetPrefix = Boolean(targetMatch);
  const parts = targetMatch ?? legacyMatch;

  if (!parts) {
    return null;
  }

  const [, firstPrefixPart, secondPrefixPart, bayRaw, shelfLabelRaw, slotRaw] = parts;
  const zoneRaw = usesTargetPrefix ? firstPrefixPart : secondPrefixPart;
  const aisleRaw = usesTargetPrefix ? secondPrefixPart : firstPrefixPart;
  const zoneIndex = Number.parseInt(zoneRaw, 10);
  const aisle = numberFromLetters(aisleRaw);
  const bay = Number.parseInt(bayRaw, 10);
  const slot = Number.parseInt(slotRaw, 10);
  const shelfIndex = numberFromLetters(shelfLabelRaw);

  return {
    name: cleanName,
    zoneLabel: pad2(zoneIndex),
    zoneIndex,
    aisleLabel: aisleRaw.toUpperCase(),
    aisle,
    bay,
    shelfLabel: shelfLabelRaw.toUpperCase(),
    shelfIndex,
    slot,
    side: bay % 2 === 1 ? "left" : "right",
    originalIndex,
    zeroPadded: zoneRaw.length >= 2 && bayRaw.length >= 2 && slotRaw.length >= 2,
    usesTargetPrefix,
  };
}

function bayRouteKey(location: LocationRecord) {
  return `${location.zoneIndex}-${location.aisle}-${location.bay}`;
}

function pickCoordinateKey(
  zoneIndex: number,
  aisle: number,
  bay: number,
  shelfIndex: number,
  slot: number,
) {
  return `${zoneIndex}-${aisle}-${bay}-${shelfIndex}-${slot}`;
}

function buildHighlightedStops(locations: LocationRecord[]) {
  const seenBays = new Set<string>();

  return locations.filter((location) => {
    const key = bayRouteKey(location);

    if (seenBays.has(key)) {
      return false;
    }

    seenBays.add(key);
    return true;
  });
}

function generateLocations(config: LayoutConfig) {
  const locations: LocationRecord[] = [];

  for (let zone = 1; zone <= config.zones; zone += 1) {
    for (let aisle = 1; aisle <= config.aisles; aisle += 1) {
      for (let bay = 1; bay <= config.bays; bay += 1) {
        for (let shelf = 1; shelf <= config.shelves; shelf += 1) {
          for (let slot = 1; slot <= config.slots; slot += 1) {
            const parsed = parseLocationName(
              locationName(zone, aisle, bay, shelf, slot),
              locations.length,
            );
            if (parsed) {
              locations.push(parsed);
            }
          }
        }
      }
    }
  }

  return locations.sort((a, b) => alphaSort(a.name, b.name));
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(cell);
      if (row.some((value) => value.trim().length > 0)) {
        rows.push(row);
      }
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell);
  if (row.some((value) => value.trim().length > 0)) {
    rows.push(row);
  }

  return rows;
}

function inferConfig(records: LocationRecord[]): LayoutConfig {
  return records.reduce<LayoutConfig>(
    (max, record) => ({
      zones: Math.max(max.zones, record.zoneIndex),
      aisles: Math.max(max.aisles, record.aisle),
      bays: Math.max(max.bays, record.bay),
      shelves: Math.max(max.shelves, record.shelfIndex),
      slots: Math.max(max.slots, record.slot),
    }),
    { zones: 1, aisles: 1, bays: 1, shelves: 1, slots: 1 },
  );
}

function analyzeImportedCsv(text: string, fileName: string): UploadAnalysis {
  const rows = parseCsv(text);
  const headers = rows[0]?.map((header) => header.trim().toLowerCase()) ?? [];
  const headerNameIndex = headers.findIndex(
    (header) => header === "name" || header === "location name",
  );
  const nameIndex = headerNameIndex >= 0 ? headerNameIndex : 0;
  const names = rows
    .slice(headers.length > 0 ? 1 : 0)
    .map((row) => row[nameIndex]?.trim() ?? "")
    .filter(Boolean);
  const counts = new Map<string, number>();

  names.forEach((name) => {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  });

  const validLocations = names
    .map((name, index) => parseLocationName(name, index))
    .filter((location): location is LocationRecord => Boolean(location))
    .sort((a, b) => alphaSort(a.name, b.name));

  const invalidNames = names.filter((name, index) => !parseLocationName(name, index));
  const duplicateNames = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name);
  const nonPaddedNames = validLocations
    .filter((location) => !location.zeroPadded)
    .map((location) => location.name);
  const legacyPrefixNames = validLocations
    .filter((location) => !location.usesTargetPrefix)
    .map((location) => location.name);
  const routeBacktracks: string[] = [];

  validLocations.forEach((current, index) => {
    const previous = validLocations[index - 1];
    if (!previous) {
      return;
    }

    const sameZone = current.zoneIndex === previous.zoneIndex;
    const movedBackward =
      sameZone &&
      (current.aisle < previous.aisle ||
        (current.aisle === previous.aisle && current.bay < previous.bay));

    if (movedBackward) {
      routeBacktracks.push(`${previous.name} -> ${current.name}`);
    }
  });

  return {
    fileName,
    totalRows: names.length,
    validLocations,
    invalidNames,
    duplicateNames,
    nonPaddedNames,
    legacyPrefixNames,
    routeBacktracks,
    inferredConfig: inferConfig(validLocations),
  };
}

function csvEscape(value: string) {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

function buildShipHeroCsv(locations: LocationRecord[]) {
  const header = ["Name", "Pickable", "Priority", "Type", "Sellable"];
  const rows = locations.map((location) => [
    location.name,
    "Yes",
    "0",
    "Bin",
    "Yes",
  ]);

  return [header, ...rows]
    .map((row) => row.map(csvEscape).join(","))
    .join("\n");
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function HealthPill({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: "good" | "warn" | "bad";
}) {
  return (
    <div className={`health-pill ${tone}`}>
      <strong>{count}</strong>
      <span>{label}</span>
    </div>
  );
}

function PageTabs({
  activePage,
  onChange,
}: {
  activePage: PageKey;
  onChange: (page: PageKey) => void;
}) {
  return (
    <nav className="page-tabs" aria-label="Simulator pages">
      {pageLabels.map((page) => (
        <button
          aria-current={activePage === page.key ? "page" : undefined}
          className={activePage === page.key ? "active" : ""}
          key={page.key}
          onClick={() => onChange(page.key)}
          type="button"
        >
          {page.label}
        </button>
      ))}
    </nav>
  );
}

function SourceSwitch({
  mode,
  canUseUploaded,
  onChange,
}: {
  mode: SourceMode;
  canUseUploaded: boolean;
  onChange: (mode: SourceMode) => void;
}) {
  return (
    <div className="mode-switch" aria-label="Simulation source">
      <button
        className={mode === "generated" ? "active" : ""}
        onClick={() => onChange("generated")}
        type="button"
      >
        Generated layout
      </button>
      <button
        className={mode === "uploaded" ? "active" : ""}
        disabled={!canUseUploaded}
        onClick={() => onChange("uploaded")}
        type="button"
      >
        Uploaded CSV
      </button>
    </div>
  );
}

function PlaybackControls({
  active,
  activeIndex,
  total,
  isPlaying,
  speedMs,
  onPrevious,
  onNext,
  onPlayPause,
  onSeek,
  onSpeedChange,
}: {
  active: LocationRecord | undefined;
  activeIndex: number;
  total: number;
  isPlaying: boolean;
  speedMs: number;
  onPrevious: () => void;
  onNext: () => void;
  onPlayPause: () => void;
  onSeek: (index: number) => void;
  onSpeedChange: (speedMs: number) => void;
}) {
  return (
    <section className="panel playback-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Replay</p>
          <h2>{active?.name ?? "No active location"}</h2>
        </div>
        <span className="small-badge">{total ? `${activeIndex + 1} / ${total}` : "0 / 0"}</span>
      </div>

      <div className="playback-row">
        <button className="ghost-action" onClick={onPrevious} type="button">
          Previous
        </button>
        <button className="primary-action compact" onClick={onPlayPause} type="button">
          {isPlaying ? "Pause" : "Play"}
        </button>
        <button className="ghost-action" onClick={onNext} type="button">
          Next
        </button>
      </div>

      <label className="range-field">
        <span>Route position</span>
        <input
          max={Math.max(0, total - 1)}
          min={0}
          onChange={(event) => onSeek(Number.parseInt(event.target.value, 10))}
          type="range"
          value={activeIndex}
        />
      </label>

      <label className="range-field speed-field">
        <span>Speed</span>
        <input
          max={1400}
          min={160}
          onChange={(event) => onSpeedChange(Number.parseInt(event.target.value, 10))}
          step={40}
          type="range"
          value={speedMs}
        />
        <strong>{(speedMs / 1000).toFixed(2)} sec / pick</strong>
      </label>
    </section>
  );
}

function CreatePage({
  config,
  generatedLocations,
  mode,
  canUseUploaded,
  onConfigChange,
  onSourceChange,
}: {
  config: LayoutConfig;
  generatedLocations: LocationRecord[];
  mode: SourceMode;
  canUseUploaded: boolean;
  onConfigChange: (key: keyof LayoutConfig, value: number) => void;
  onSourceChange: (mode: SourceMode) => void;
}) {
  return (
    <div className="page-grid create-grid">
      <section className="panel input-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Warehouse dimensions</p>
            <h2>Create bin locations</h2>
          </div>
        </div>
        <div className="input-grid wide">
          {(Object.keys(config) as Array<keyof LayoutConfig>).map((key) => (
            <label className="number-field" key={key}>
              <span>{labels[key]}</span>
              <input
                max={inputLimits[key]}
                min={1}
                onChange={(event) =>
                  onConfigChange(key, Number.parseInt(event.target.value, 10))
                }
                type="number"
                value={config[key]}
              />
            </label>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Simulation source</p>
            <h2>Generated or imported</h2>
          </div>
        </div>
        <SourceSwitch
          canUseUploaded={canUseUploaded}
          mode={mode}
          onChange={onSourceChange}
        />
      </section>

      <section className="panel generated-reference-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Generated reference</p>
            <h2>Current layout</h2>
          </div>
        </div>
        <div className="summary-band">
          <Stat
            label="Generated bin locations"
            value={generatedLocations.length.toLocaleString()}
          />
          <Stat label="First location" value={generatedLocations[0]?.name ?? "-"} />
          <Stat
            label="Last location"
            value={generatedLocations[generatedLocations.length - 1]?.name ?? "-"}
          />
        </div>
      </section>
    </div>
  );
}

function OverheadRoute({
  locations,
  activeIndex,
  active,
  config,
}: {
  locations: LocationRecord[];
  activeIndex: number;
  active: LocationRecord | undefined;
  config: LayoutConfig;
}) {
  const activeZoneIndex = active?.zoneIndex ?? 1;
  const activeZone = active?.zoneLabel ?? "01";
  const stopIndexByBay = useMemo(() => {
    const steps = new Map<string, number>();

    locations.forEach((location, index) => {
      if (location.zoneIndex !== activeZoneIndex) {
        return;
      }

      steps.set(`${location.aisle}-${location.bay}`, index);
    });

    return steps;
  }, [activeZoneIndex, locations]);

  const aisles = Array.from({ length: config.aisles }, (_, index) => index + 1);
  const pairCount = Math.ceil(config.bays / 2);
  const pairs = Array.from({ length: pairCount }, (_, index) => ({
    odd: index * 2 + 1,
    even: index * 2 + 2,
  }));

  const bayClassName = (aisle: number, bay: number) => {
    const step = stopIndexByBay.get(`${aisle}-${bay}`);
    const isActive = active?.aisle === aisle && active.bay === bay;
    const isPlanned = typeof step === "number";
    const isDone = typeof step === "number" && activeIndex > step;

    return `warehouse-bay ${isPlanned ? "planned" : ""} ${
      isActive ? "active" : ""
    } ${isDone ? "done" : ""}`;
  };

  return (
    <section className="panel visualization-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Overhead simulation</p>
          <h2>Zone {activeZone}</h2>
        </div>
        <span className="small-badge">Serpentine path</span>
      </div>

      <div className="warehouse-scroll">
        <div className="warehouse-outline serpentine-outline">
          <div
            className="serpentine-grid"
            style={{ gridTemplateColumns: `repeat(${config.aisles}, minmax(164px, 1fr))` }}
          >
            {aisles.map((aisle) => {
              const aisleLabel = lettersFromNumber(aisle);
              const direction = aisle % 2 === 1 ? "up" : "down";
              const physicalPairs = direction === "up" ? [...pairs].reverse() : pairs;

              return (
                <div className={`warehouse-aisle serpentine-aisle ${direction}`} key={aisle}>
                  <div className="aisle-header">
                    <strong>{activeZone}{aisleLabel}</strong>
                    <span>Aisle {aisleLabel}</span>
                  </div>

                  <div
                    className="serpentine-bay-stack"
                    style={{ gridTemplateRows: `repeat(${pairCount}, minmax(72px, 1fr))` }}
                  >
                    {physicalPairs.map(({ odd, even }) => {
                      const oddStep = stopIndexByBay.get(`${aisle}-${odd}`);
                      const evenStep = stopIndexByBay.get(`${aisle}-${even}`);
                      const plannedSteps = [oddStep, evenStep].filter(
                        (step): step is number => typeof step === "number",
                      );
                      const isActivePair =
                        active?.aisle === aisle && (active.bay === odd || active.bay === even);
                      const isDonePair =
                        plannedSteps.length > 0 &&
                        plannedSteps.every((step) => activeIndex > step);

                      return (
                        <div
                          className={`serpentine-pair ${isActivePair ? "active-pair" : ""}`}
                          key={`${aisle}-${odd}-${even}`}
                        >
                          <div className={bayClassName(aisle, odd)}>
                            <span>Bay {pad2(odd)}</span>
                          </div>
                          <div
                            className={`aisle-track ${direction} ${
                              isActivePair ? "active" : ""
                            } ${isDonePair ? "done" : ""}`}
                          >
                            {isActivePair && (
                              <>
                                <div className={`pick-tether ${active?.side ?? "left"}`} />
                                <div className="overhead-picker">
                                  <span>Picker</span>
                                </div>
                              </>
                            )}
                          </div>
                          {even <= config.bays ? (
                            <div className={bayClassName(aisle, even)}>
                              <span>Bay {pad2(even)}</span>
                            </div>
                          ) : (
                            <div className="warehouse-bay empty" />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function RackBay({
  bay,
  active,
  config,
  indexByName,
  activeIndex,
}: {
  bay: number | null;
  active: LocationRecord | undefined;
  config: LayoutConfig;
  indexByName: Map<string, number>;
  activeIndex: number;
}) {
  const shelves = Array.from({ length: config.shelves }, (_, index) => config.shelves - index);
  const slots = Array.from({ length: config.slots }, (_, index) => index + 1);

  return (
    <div className={`rack-bay ${bay === active?.bay ? "active-bay" : ""}`}>
      <div className="rack-title">
        <span>{bay ? `Bay ${pad2(bay)}` : "No bay"}</span>
        <strong>{bay && bay % 2 === 1 ? "Left" : "Right"}</strong>
      </div>
      <div className="shelf-stack">
        {shelves.map((shelf) => (
          <div className="shelf-row" key={`${bay}-${shelf}`}>
            <span className="shelf-label">{lettersFromNumber(shelf)}</span>
            <div
              className="slot-grid"
              style={{ gridTemplateColumns: `repeat(${config.slots}, minmax(34px, 1fr))` }}
            >
              {slots.map((slot) => {
                const name =
                  active && bay
                    ? locationName(active.zoneIndex, active.aisle, bay, shelf, slot)
                    : "";
                const coordinate =
                  active && bay
                    ? pickCoordinateKey(active.zoneIndex, active.aisle, bay, shelf, slot)
                    : "";
                const stepIndex = indexByName.get(coordinate);
                const isActive = active
                  ? coordinate ===
                    pickCoordinateKey(
                      active.zoneIndex,
                      active.aisle,
                      active.bay,
                      active.shelfIndex,
                      active.slot,
                    )
                  : false;
                const isDone = typeof stepIndex === "number" && stepIndex < activeIndex;
                const isPlanned = typeof stepIndex === "number";

                return (
                  <div
                    className={`slot ${isPlanned ? "planned" : "unplanned"} ${
                      isActive ? "active" : ""
                    } ${isDone ? "done" : ""}`}
                    key={`${bay}-${shelf}-${slot}`}
                    title={name}
                  >
                    <span>{pad2(slot)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AislePickView({
  locations,
  activeIndex,
  active,
  config,
}: {
  locations: LocationRecord[];
  activeIndex: number;
  active: LocationRecord | undefined;
  config: LayoutConfig;
}) {
  const indexByName = useMemo(() => {
    const map = new Map<string, number>();
    locations.forEach((location, index) =>
      map.set(
        pickCoordinateKey(
          location.zoneIndex,
          location.aisle,
          location.bay,
          location.shelfIndex,
          location.slot,
        ),
        index,
      ),
    );
    return map;
  }, [locations]);

  const pairCount = Math.ceil(config.bays / 2);
  const activePair = active ? Math.floor((active.bay - 1) / 2) : 0;
  const basePair = Math.max(0, Math.min(activePair, Math.max(0, pairCount - 2)));
  const visiblePairs = [basePair, Math.min(pairCount - 1, basePair + 1)];
  const leftBays = visiblePairs.map((pair) => pair * 2 + 1).filter((bay) => bay <= config.bays);
  const rightBays = visiblePairs.map((pair) => pair * 2 + 2).filter((bay) => bay <= config.bays);

  return (
    <section className="panel visualization-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Aisle simulation</p>
          <h2>{active ? `${active.zoneLabel}${active.aisleLabel}` : "No location"}</h2>
        </div>
        <span className="small-badge">{active?.name ?? "No active pick"}</span>
      </div>

      <div className="aisle-window">
        <div className="rack-bank left-bank">
          <div className="bank-label">Left side, odd bays</div>
          <div className="rack-bay-row">
            {leftBays.map((bay) => (
              <RackBay
                active={active}
                activeIndex={activeIndex}
                bay={bay}
                config={config}
                indexByName={indexByName}
                key={bay}
              />
            ))}
          </div>
        </div>

        <div className="picker-lane">
          <div className={`picker-reach ${active?.side ?? "left"}`} />
          <div className="picker-marker">
            <span>Picker</span>
          </div>
          <div className="lane-line" />
        </div>

        <div className="rack-bank right-bank">
          <div className="bank-label">Right side, even bays</div>
          <div className="rack-bay-row">
            {rightBays.map((bay) => (
              <RackBay
                active={active}
                activeIndex={activeIndex}
                bay={bay}
                config={config}
                indexByName={indexByName}
                key={bay}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function RouteTimeline({
  locations,
  activeIndex,
  onSelect,
}: {
  locations: LocationRecord[];
  activeIndex: number;
  onSelect: (index: number) => void;
}) {
  const start = Math.max(0, activeIndex - 8);
  const visible = locations.slice(start, activeIndex + 18);

  return (
    <section className="panel timeline-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Pick sequence</p>
          <h2>{locations.length.toLocaleString()} highlighted picks</h2>
        </div>
      </div>
      <div className="timeline-list">
        {visible.map((location, index) => {
          const routeIndex = start + index;
          return (
            <button
              className={`route-step ${routeIndex === activeIndex ? "active" : ""} ${
                routeIndex < activeIndex ? "done" : ""
              }`}
              key={`${location.name}-${routeIndex}`}
              onClick={() => onSelect(routeIndex)}
              type="button"
            >
              <span>{routeIndex + 1}</span>
              <strong>{location.name}</strong>
              <em>{location.side}</em>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function OutputPage({
  analysis,
  activeLocations,
  generatedLocations,
  canUseUploaded,
  mode,
  onDownload,
  onUpload,
  onSourceChange,
}: {
  analysis: UploadAnalysis | null;
  activeLocations: LocationRecord[];
  generatedLocations: LocationRecord[];
  canUseUploaded: boolean;
  mode: SourceMode;
  onDownload: () => void;
  onUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onSourceChange: (mode: SourceMode) => void;
}) {
  return (
    <div className="page-grid output-grid">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">ShipHero CSV</p>
            <h2>Export</h2>
          </div>
          <span className="small-badge">{activeLocations.length.toLocaleString()} rows</span>
        </div>
        <SourceSwitch
          canUseUploaded={canUseUploaded}
          mode={mode}
          onChange={onSourceChange}
        />
        <button className="primary-action" onClick={onDownload} type="button">
          Download ShipHero CSV
        </button>
        <div className="csv-preview">
          <div className="csv-row header">
            <span>Name</span>
            <span>Pickable</span>
            <span>Priority</span>
            <span>Type</span>
            <span>Sellable</span>
          </div>
          {activeLocations.slice(0, 10).map((location) => (
            <div className="csv-row" key={location.name}>
              <span>{location.name}</span>
              <span>Yes</span>
              <span>0</span>
              <span>Bin</span>
              <span>Yes</span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Customer CSV</p>
            <h2>Import check</h2>
          </div>
        </div>
        <label className="file-drop">
          <input accept=".csv,text/csv" onChange={onUpload} type="file" />
          <span>Choose CSV</span>
          <strong>{analysis?.fileName ?? "No file selected"}</strong>
        </label>
        <div className="health-grid">
          <HealthPill
            count={analysis?.validLocations.length ?? 0}
            label="valid"
            tone="good"
          />
          <HealthPill
            count={analysis?.invalidNames.length ?? 0}
            label="invalid"
            tone={(analysis?.invalidNames.length ?? 0) > 0 ? "bad" : "good"}
          />
          <HealthPill
            count={analysis?.duplicateNames.length ?? 0}
            label="duplicates"
            tone={(analysis?.duplicateNames.length ?? 0) > 0 ? "bad" : "good"}
          />
          <HealthPill
            count={analysis?.routeBacktracks.length ?? 0}
            label="backtracks"
            tone={(analysis?.routeBacktracks.length ?? 0) > 0 ? "warn" : "good"}
          />
          <HealthPill
            count={analysis?.legacyPrefixNames.length ?? 0}
            label="legacy prefix"
            tone={(analysis?.legacyPrefixNames.length ?? 0) > 0 ? "warn" : "good"}
          />
        </div>
        <div className={`issue-list ${analysis ? "" : "muted"}`}>
          {analysis ? (
            <>
              {analysis.legacyPrefixNames.slice(0, 4).map((name) => (
                <p key={`legacy-${name}`}>Legacy prefix order: {name}</p>
              ))}
              {analysis.nonPaddedNames.slice(0, 4).map((name) => (
                <p key={`pad-${name}`}>Needs padding: {name}</p>
              ))}
              {analysis.invalidNames.slice(0, 4).map((name) => (
                <p key={`invalid-${name}`}>Invalid format: {name}</p>
              ))}
              {analysis.duplicateNames.slice(0, 4).map((name) => (
                <p key={`duplicate-${name}`}>Duplicate: {name}</p>
              ))}
              {analysis.routeBacktracks.slice(0, 4).map((jump) => (
                <p key={`jump-${jump}`}>Route jump: {jump}</p>
              ))}
              {analysis.nonPaddedNames.length === 0 &&
                analysis.invalidNames.length === 0 &&
                analysis.duplicateNames.length === 0 &&
                analysis.legacyPrefixNames.length === 0 &&
                analysis.routeBacktracks.length === 0 && (
                  <p>No obvious sort or format issues in the imported names.</p>
                )}
            </>
          ) : (
            <p>Reads a ShipHero-style CSV and simulates the Name column route.</p>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Generated reference</p>
            <h2>Current layout</h2>
          </div>
        </div>
        <div className="summary-band stacked">
          <Stat
            label="Generated bin locations"
            value={generatedLocations.length.toLocaleString()}
          />
          <Stat label="First location" value={generatedLocations[0]?.name ?? "-"} />
          <Stat
            label="Last location"
            value={generatedLocations[generatedLocations.length - 1]?.name ?? "-"}
          />
        </div>
      </section>
    </div>
  );
}

export default function Home() {
  const [activePage, setActivePage] = useState<PageKey>("create");
  const [config, setConfig] = useState<LayoutConfig>(defaultConfig);
  const [activeIndex, setActiveIndex] = useState(0);
  const [speedMs, setSpeedMs] = useState(600);
  const [isPlaying, setIsPlaying] = useState(false);
  const [analysis, setAnalysis] = useState<UploadAnalysis | null>(null);
  const [mode, setMode] = useState<SourceMode>("generated");

  const generatedLocations = useMemo(() => generateLocations(config), [config]);
  const uploadedLocations = analysis?.validLocations ?? [];
  const activeLocations =
    mode === "uploaded" && uploadedLocations.length > 0
      ? uploadedLocations
      : generatedLocations;
  const routeStops = useMemo(
    () => buildHighlightedStops(activeLocations),
    [activeLocations],
  );
  const activeConfig =
    mode === "uploaded" && uploadedLocations.length > 0
      ? analysis?.inferredConfig ?? config
      : config;
  const safeActiveIndex = Math.min(
    activeIndex,
    Math.max(0, routeStops.length - 1),
  );
  const active = routeStops[safeActiveIndex];
  const csv = useMemo(() => buildShipHeroCsv(activeLocations), [activeLocations]);
  const canUseUploaded = uploadedLocations.length > 0;

  useEffect(() => {
    if (!isPlaying || routeStops.length === 0) {
      return;
    }

    const timer = window.setInterval(() => {
      setActiveIndex((current) => {
        if (current >= routeStops.length - 1) {
          window.clearInterval(timer);
          setIsPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, speedMs);

    return () => window.clearInterval(timer);
  }, [isPlaying, routeStops.length, speedMs]);

  const updateConfig = (key: keyof LayoutConfig, value: number) => {
    setActiveIndex(0);
    setIsPlaying(false);
    setConfig((current) => ({
      ...current,
      [key]: clampNumber(value, 1, inputLimits[key]),
    }));
  };

  const selectMode = (nextMode: SourceMode) => {
    setMode(nextMode);
    setActiveIndex(0);
    setIsPlaying(false);
  };

  const handleDownload = () => {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "shiphero_locations.csv";
    link.click();
    window.URL.revokeObjectURL(url);
  };

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const text = await file.text();
    const uploadAnalysis = analyzeImportedCsv(text, file.name);
    setAnalysis(uploadAnalysis);
    setMode("uploaded");
    setActiveIndex(0);
    setIsPlaying(false);
  };

  const playbackControls = (
    <PlaybackControls
      active={active}
      activeIndex={safeActiveIndex}
      isPlaying={isPlaying}
      onNext={() =>
        setActiveIndex(() =>
          Math.min(Math.max(0, routeStops.length - 1), safeActiveIndex + 1),
        )
      }
      onPlayPause={() => setIsPlaying((playing) => !playing)}
      onPrevious={() => setActiveIndex(() => Math.max(0, safeActiveIndex - 1))}
      onSeek={setActiveIndex}
      onSpeedChange={setSpeedMs}
      speedMs={speedMs}
      total={routeStops.length}
    />
  );

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div>
          <p className="eyebrow">ShipHero bin planning</p>
          <h1>Bin route simulator</h1>
        </div>
        <PageTabs activePage={activePage} onChange={setActivePage} />
      </header>

      {activePage === "create" && (
        <CreatePage
          canUseUploaded={canUseUploaded}
          config={config}
          generatedLocations={generatedLocations}
          mode={mode}
          onConfigChange={updateConfig}
          onSourceChange={selectMode}
        />
      )}

      {activePage === "overhead" && (
        <div className="simulation-grid">
          <div className="simulation-main">
            <OverheadRoute
              active={active}
              activeIndex={safeActiveIndex}
              config={activeConfig}
              locations={routeStops}
            />
            <RouteTimeline
              activeIndex={safeActiveIndex}
              locations={routeStops}
              onSelect={setActiveIndex}
            />
          </div>
          <aside className="simulation-side">{playbackControls}</aside>
        </div>
      )}

      {activePage === "aisle" && (
        <div className="simulation-grid">
          <div className="simulation-main">
            <AislePickView
              active={active}
              activeIndex={safeActiveIndex}
              config={activeConfig}
              locations={routeStops}
            />
            <RouteTimeline
              activeIndex={safeActiveIndex}
              locations={routeStops}
              onSelect={setActiveIndex}
            />
          </div>
          <aside className="simulation-side">{playbackControls}</aside>
        </div>
      )}

      {activePage === "output" && (
        <OutputPage
          activeLocations={activeLocations}
          analysis={analysis}
          canUseUploaded={canUseUploaded}
          generatedLocations={generatedLocations}
          mode={mode}
          onDownload={handleDownload}
          onSourceChange={selectMode}
          onUpload={handleUpload}
        />
      )}
    </main>
  );
}
