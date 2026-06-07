# Bin Location Simulator

A Next.js proof of concept for helping new WMS customers understand how ShipHero
routes picks through bin locations. The app generates ShipHero-style location
names, simulates the alphanumeric pick path, visualizes overhead and aisle-level
movement, and exports a ShipHero upload CSV.

## Features

- Create a generated warehouse layout from zones, aisles, bays, shelves, and slots
- Simulate ShipHero's alphanumeric route order
- View an overhead warehouse rectangle with aisle labels and every bay labeled
- View an aisle-facing picker simulation with multiple bay sections visible
- Adjust replay speed while playback is running
- Import an existing location CSV and flag invalid names, duplicates, missing
  zero-padding, and route backtracks
- Export `Name, Pickable, Priority, Type, Sellable` CSV rows for ShipHero

## Local Development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Validation

```bash
npm run lint
npm run build
```

## Deploying To Vercel

This is a standard Next.js App Router project. Import the GitHub repository into
Vercel and use the default Next.js build settings:

- Build command: `npm run build`
- Install command: `npm install`
- Output directory: Next.js default
