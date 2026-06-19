import { useEffect, useRef, useState, type CSSProperties } from 'react'
import mqtt from 'mqtt'
import './App.css'

const BROKER = 'wss://02d2caf5b468442a8c326f842428590f.s1.eu.hivemq.cloud:8884/mqtt'
const USERNAME = 'brodpet1'
const PASSWORD = 'Brodpet18'
const EXPECTED_UPDATE_SECONDS = 10
const STALE_SECONDS = 120
const CELLS_PER_PACK = 8
const TOTAL_BATTERY_CAPACITY_AH = 908
const PACKS = ['CALB-new314ah', 'CALB-314ah', 'Cornex-280ah']
const PACK_LABELS: Record<string, string> = {
  'CALB-new314ah': 'CALB New 314Ah',
  'CALB-314ah': 'CALB 314Ah',
  'Cornex-280ah': 'Cornex 280Ah',
}
const SENSOR_PACKS: Record<string, string> = {
  'calb-new314ah': 'CALB-new314ah',
  calb_314ah: 'CALB-314ah',
  cornex_280ah: 'Cornex-280ah',
}
const SENSOR_FIELDS: Record<string, keyof Omit<PackData, 'cells' | 'updatedAt'>> = {
  soc: 'soc',
  total_voltage: 'voltage',
  current: 'current',
  power: 'power',
  temperature_1: 'temp1',
  temperature_2: 'temp2',
  mosfet_temperature: 'mosfet_temp',
  capacity_remaining: 'capacity',
  min_cell_voltage: 'min_cell',
  max_cell_voltage: 'max_cell',
  delta_cell_voltage: 'delta_cell',
}

interface PackData {
  soc: number
  voltage: number
  current: number
  power: number
  temp1: number
  temp2: number
  mosfet_temp: number
  capacity: number
  min_cell: number
  max_cell: number
  delta_cell: number
  cells: number[]
  updatedAt: number
}

type PackMap = Record<string, PackData>

function emptyPack(): PackData {
  return {
    soc: 0,
    voltage: 0,
    current: 0,
    power: 0,
    temp1: 0,
    temp2: 0,
    mosfet_temp: 0,
    capacity: 0,
    min_cell: 0,
    max_cell: 0,
    delta_cell: 0,
    cells: Array(CELLS_PER_PACK).fill(0),
    updatedAt: Date.now(),
  }
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function buildAggregatePack(packs: PackData[]): PackData | undefined {
  if (!packs.length) return undefined

  const cells = Array.from({ length: CELLS_PER_PACK }, (_, index) => {
    const liveCells = packs.map(pack => pack.cells[index]).filter(value => value > 0)
    return average(liveCells)
  })
  const liveCells = cells.filter(value => value > 0)
  const minCell = liveCells.length ? Math.min(...liveCells) : 0
  const maxCell = liveCells.length ? Math.max(...liveCells) : 0

  return {
    soc: Math.round(average(packs.map(pack => pack.soc))),
    voltage: average(packs.map(pack => pack.voltage)),
    current: packs.reduce((sum, pack) => sum + pack.current, 0),
    power: packs.reduce((sum, pack) => sum + pack.power, 0),
    temp1: average(packs.map(pack => pack.temp1)),
    temp2: average(packs.map(pack => pack.temp2)),
    mosfet_temp: average(packs.map(pack => pack.mosfet_temp)),
    capacity: packs.reduce((sum, pack) => sum + pack.capacity, 0),
    min_cell: minCell,
    max_cell: maxCell,
    delta_cell: maxCell - minCell,
    cells,
    updatedAt: Math.min(...packs.map(pack => pack.updatedAt)),
  }
}

function parseSensorTopic(topic: string): { pack: string; field: string; cell?: number } | null {
  if (!topic.startsWith('jk-bms/sensor/') || !topic.endsWith('/state')) return null

  const entity = topic.slice('jk-bms/sensor/'.length, -'/state'.length)
  for (const [slug, pack] of Object.entries(SENSOR_PACKS)) {
    if (!entity.startsWith(`${slug}_`)) continue

    const sensor = entity.slice(slug.length + 1)
    const cell = sensor.match(/^cell_(\d+)$/)
    if (cell) return { pack, field: 'cell', cell: Number(cell[1]) - 1 }

    return { pack, field: sensor }
  }

  return null
}

function formatNumber(value: number | null | undefined, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return '--'
  return value.toFixed(digits)
}

function getAge(data: PackData | undefined, now: number) {
  return data ? Math.floor((now - data.updatedAt) / 1000) : null
}

function isStale(data: PackData | undefined, now: number) {
  const age = getAge(data, now)
  return age !== null && age > STALE_SECONDS
}

function getPackHealth(data: PackData | undefined, now: number) {
  if (!data) return { label: 'Waiting', tone: 'muted' }
  if (isStale(data, now)) return { label: 'Stale', tone: 'danger' }
  if (data.soc < 20) return { label: 'Low SOC', tone: 'danger' }
  if (data.mosfet_temp > 60 || data.delta_cell > 0.05) return { label: 'Check', tone: 'warning' }
  return { label: 'Balanced', tone: 'good' }
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(value)
}

function formatDuration(hours: number | null) {
  if (hours === null || !Number.isFinite(hours) || hours < 0) return '--'
  if (hours < 1) return `${Math.round(hours * 60)}m`

  const wholeHours = Math.floor(hours)
  const minutes = Math.round((hours - wholeHours) * 60)
  if (wholeHours >= 24) {
    const days = Math.floor(wholeHours / 24)
    const remainingHours = wholeHours % 24
    return `${days}d ${remainingHours}h`
  }

  return minutes ? `${wholeHours}h ${minutes}m` : `${wholeHours}h`
}

function StatusPill({ label, tone = 'muted' }: { label: string; tone?: string }) {
  return <span className={`status-pill ${tone}`}>{label}</span>
}

function MetricTile({ label, value, helper, tone }: { label: string; value: string; helper?: string; tone?: string }) {
  return (
    <div className={`metric-tile ${tone ?? ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {helper && <small>{helper}</small>}
    </div>
  )
}

function SocDial({ value, label }: { value: number; label: string }) {
  const safeValue = Math.max(0, Math.min(100, value || 0))
  const style = { '--soc': `${safeValue * 3.6}deg` } as CSSProperties

  return (
    <div className="soc-dial-wrap">
      <div className="soc-dial" style={style}>
        <div>
          <strong>{formatNumber(value)}%</strong>
        </div>
      </div>
      <span>{label}</span>
    </div>
  )
}

function DashboardLogo() {
  return (
    <div className="dashboard-logo" aria-label="BRODPET SOLAR">
      <span className="sun-mark" />
      <span>BRODPET <strong>SOLAR</strong></span>
    </div>
  )
}

function HeaderBar({ status, tone, now }: {
  status: string
  tone: string
  now: number
}) {
  return (
    <header className="topbar">
      <div className="title-cluster">
        <DashboardLogo />
        <i />
        <h1>JK BMS Command Deck</h1>
      </div>
      <div className="top-actions">
        <StatusPill label={status} tone={tone} />
        <span className="clock-readout">{formatTime(now)}</span>
      </div>
    </header>
  )
}

function BatteryEstimate({ totalPower, remainingAh, voltage }: { totalPower: number; remainingAh: number; voltage: number | null }) {
  const activePower = Math.abs(totalPower) > 50
  const missingData = !activePower || !voltage || remainingAh <= 0
  const remainingWh = remainingAh * (voltage ?? 0)
  const fullWh = TOTAL_BATTERY_CAPACITY_AH * (voltage ?? 0)
  const emptyWh = Math.max(0, remainingWh)
  const chargeWh = Math.max(0, fullWh - remainingWh)
  const isCharging = totalPower > 50
  const estimate = missingData ? null : isCharging ? chargeWh / totalPower : emptyWh / Math.abs(totalPower)

  return (
    <div className="battery-estimate">
      <span>{isCharging ? 'Estimated full charge' : totalPower < -50 ? 'Estimated discharge' : 'Battery estimate'}</span>
      <strong>{formatDuration(estimate)}</strong>
      <small>{missingData ? 'Waiting for live power' : `Based on ${totalPower > 0 ? '+' : ''}${formatNumber(totalPower)}W now`}</small>
    </div>
  )
}

function getBatteryState(totalPower: number) {
  if (totalPower > 50) return { label: 'Charging', tone: 'good', helper: 'Battery bank receiving power' }
  if (totalPower < -50) return { label: 'Discharging', tone: 'warning', helper: 'Battery bank supplying power' }
  return { label: 'Idle', tone: 'muted', helper: 'Power flow near zero' }
}

function BatteryState({ totalPower }: { totalPower: number }) {
  const state = getBatteryState(totalPower)

  return (
    <div className={`battery-state ${state.tone}`}>
      <span>State</span>
      <strong>{state.label}</strong>
      <small>{state.helper}</small>
    </div>
  )
}
function BatteryDeck({ averageVoltage, totalCurrent, totalPower, remainingAh }: {
  averageVoltage: number | null
  totalCurrent: number
  totalPower: number
  remainingAh: number
}) {

  return (
    <section className="battery-deck" aria-label="Battery bank status">
      <div className="flow-node battery-node">
        <span className="battery-icon"><i /></span>
        <div>
          <small>Battery Bank</small>
          <strong>{averageVoltage !== null ? `${formatNumber(averageVoltage, 2)}V` : '--'}</strong>
          <em>{averageVoltage !== null ? `${totalCurrent > 0 ? '+' : ''}${formatNumber(totalCurrent, 1)}A` : '--'} &nbsp; {totalPower > 0 ? '+' : ''}{formatNumber(totalPower)}W</em>
        </div>
      </div>
      <BatteryState totalPower={totalPower} />
      <BatteryEstimate totalPower={totalPower} remainingAh={remainingAh} voltage={averageVoltage} />
    </section>
  )
}

function CellMap({ cells }: { cells: number[] }) {
  const visibleCells = cells.slice(0, CELLS_PER_PACK)
  const liveCells = visibleCells.filter(value => value > 0)
  const min = liveCells.length ? Math.min(...liveCells) : null
  const max = liveCells.length ? Math.max(...liveCells) : null

  return (
    <div className="cell-map">
      {visibleCells.map((value, index) => {
        const hasValue = value > 0
        const isMin = hasValue && min !== max && value === min
        const isMax = hasValue && min !== max && value === max

        return (
          <div className={`cell ${isMin ? 'min' : ''} ${isMax ? 'max' : ''} ${hasValue ? '' : 'empty'}`} key={index}>
            <span>C{index + 1}</span>
            <strong>{hasValue ? value.toFixed(3) : '--'}</strong>
          </div>
        )
      })}
    </div>
  )
}

function PackSelector({ selectedView, onSelect }: { selectedView: string; onSelect: (name: string) => void }) {
  return (
    <nav className="pack-tabs" aria-label="Battery packs">
      <button className={selectedView === 'all' ? 'active' : ''} onClick={() => onSelect('all')}>All</button>
      {PACKS.map(name => (
        <button className={selectedView === name ? 'active' : ''} key={name} onClick={() => onSelect(name)}>
          {name === 'CALB-new314ah' ? 'CALB New' : name === 'CALB-314ah' ? 'CALB' : 'Cornex'}
        </button>
      ))}
    </nav>
  )
}

function PackPanel({ name, data, now, selectedView, onSelect }: {
  name: string
  data: PackData | undefined
  now: number
  selectedView: string
  onSelect: (name: string) => void
}) {
  const health = getPackHealth(data, now)
  const age = getAge(data, now)
  const countdown = age !== null ? Math.max(0, EXPECTED_UPDATE_SECONDS - age) : null
  const cells = data?.cells ?? Array(CELLS_PER_PACK).fill(0)
  const liveCells = cells.filter(value => value > 0)
  const avgCell = liveCells.length ? liveCells.reduce((sum, value) => sum + value, 0) / liveCells.length : null

  return (
    <section className="pack-panel">
      <div className="panel-header">
        <div>
          <span className="eyebrow">Active pack</span>
          <h2>{name === 'all' ? 'All Battery Packs' : PACK_LABELS[name] ?? name}</h2>
        </div>
        <div className="panel-actions">
          <StatusPill label={health.label} tone={health.tone} />
          <PackSelector selectedView={selectedView} onSelect={onSelect} />
        </div>
      </div>

      {data ? (
        <>
          <div className="pack-hero command-panel">
            <SocDial value={data.soc} label="SOC" />
            <div className="pack-readings">
              <MetricTile label="Voltage" value={`${formatNumber(data.voltage, 2)}V`} />
              <MetricTile label="Current" value={`${data.current > 0 ? '+' : ''}${formatNumber(data.current, 1)}A`} tone={data.current < 0 ? 'warning' : 'good'} />
              <MetricTile label="Power" value={`${formatNumber(data.power)}W`} />
              <MetricTile label="Avg cell voltage" value={avgCell !== null ? `${formatNumber(avgCell, 3)}V` : '--'} />
              <MetricTile label="Delta (max - min)" value={`${formatNumber(data.delta_cell * 1000)}mV`} tone={data.delta_cell > 0.05 ? 'warning' : 'good'} />
              <MetricTile label="Remaining" value={`${formatNumber(data.capacity, 1)}Ah`} />
            </div>

            <div className="cell-section">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">24V pack</span>
                  <h3>8-cell voltage map</h3>
                </div>
                <span>{age !== null ? `Last ${age}s ago` : 'Waiting'}</span>
              </div>
              <CellMap cells={cells} />
              <div className="cell-legend">
                <span><i className="legend-min" />Lowest cell</span>
                <span><i className="legend-max" />Highest cell</span>
                <span><i className="legend-normal" />Other cells</span>
              </div>
            </div>
          </div>

          <div className="detail-strip">
            <MetricTile label="Health" value={health.label} tone={health.tone} helper="SOH not measured" />
            <MetricTile label="MOSFET temp" value={`${formatNumber(data.mosfet_temp, 1)}C`} tone={data.mosfet_temp > 60 ? 'warning' : ''} />
            <MetricTile label="Temperatures" value={`${formatNumber(data.temp1, 1)}C / ${formatNumber(data.temp2, 1)}C`} />
            <MetricTile label="Next update" value={countdown !== null ? `${countdown}s` : '--'} helper={age !== null ? `Last ${age}s ago` : 'Waiting'} />
          </div>
        </>
      ) : (
        <div className="empty-panel">
          <strong>Waiting for {name === 'all' ? 'battery pack data' : PACK_LABELS[name] ?? name}</strong>
          <span>No MQTT sensor values have arrived for this pack yet.</span>
        </div>
      )}
    </section>
  )
}

function AlertsPanel({ packs, now }: { packs: PackMap; now: number }) {
  const alerts = PACKS.flatMap(name => {
    const data = packs[name]
    const label = PACK_LABELS[name] ?? name
    if (!data) return [`${label} is waiting for data`]
    if (isStale(data, now)) return [`${label} data is stale`]

    const packAlerts = []
    if (data.soc < 20) packAlerts.push(`${label} SOC is below 20%`)
    if (data.delta_cell > 0.05) packAlerts.push(`${label} cell delta is high`)
    if (data.mosfet_temp > 60) packAlerts.push(`${label} MOSFET temperature is high`)
    return packAlerts
  })

  return (
    <aside className="side-panel">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Watchlist</span>
          <h3>Alerts</h3>
        </div>
        <StatusPill label={alerts.length ? `${alerts.length} active` : 'Clear'} tone={alerts.length ? 'warning' : 'good'} />
      </div>

      {alerts.length ? (
        <ul className="alert-list">
          {alerts.map(alert => <li key={alert}>{alert}</li>)}
        </ul>
      ) : (
        <div className="quiet-state">
          <strong>No active faults</strong>
          <span>All reporting packs are inside the dashboard thresholds.</span>
        </div>
      )}
    </aside>
  )
}

function PackComparison({ packs, now, selectedView, onSelect }: {
  packs: PackMap
  now: number
  selectedView: string
  onSelect: (name: string) => void
}) {
  return (
    <section className="pack-comparison" aria-label="Pack comparison">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Compare</span>
          <h3>Pack comparison</h3>
        </div>
      </div>

      <div className="comparison-table">
        <div className="comparison-header">
          <span>Pack</span>
          <span>Status</span>
          <span>SOC</span>
          <span>Voltage</span>
          <span>Current</span>
          <span>Power</span>
          <span>Temp</span>
          <span>Delta</span>
          <span>Last</span>
        </div>

        {PACKS.map(name => {
          const data = packs[name]
          const health = getPackHealth(data, now)
          const age = getAge(data, now)

          return (
            <button
              className={`comparison-row ${selectedView === name ? 'active' : ''}`}
              key={name}
              onClick={() => onSelect(name)}
            >
              <strong>{PACK_LABELS[name] ?? name}</strong>
              <span><StatusPill label={health.label} tone={health.tone} /></span>
              <span data-label="SOC">{data ? `${formatNumber(data.soc)}%` : '--'}</span>
              <span data-label="Voltage">{data ? `${formatNumber(data.voltage, 2)}V` : '--'}</span>
              <span data-label="Current">{data ? `${data.current > 0 ? '+' : ''}${formatNumber(data.current, 1)}A` : '--'}</span>
              <span data-label="Power">{data ? `${formatNumber(data.power)}W` : '--'}</span>
              <span data-label="Temp">{data ? `${formatNumber(data.temp1, 1)}C` : '--'}</span>
              <span data-label="Delta">{data ? `${formatNumber(data.delta_cell * 1000)}mV` : '--'}</span>
              <span data-label="Last">{age !== null ? `${age}s` : '--'}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

function TrendsPanel({ data, totalSoc, totalPower }: { data: PackData | undefined; totalSoc: number | null; totalPower: number }) {
  return (
    <aside className="side-panel trends-panel">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Live snapshot</span>
          <h3>Battery readings</h3>
        </div>
      </div>
      <div className="trend-list">
        <div><span>Pack voltage</span><i /><strong>{data ? `${formatNumber(data.voltage, 2)}V` : '--'}</strong></div>
        <div><span>Pack current</span><i /><strong>{data ? `${data.current > 0 ? '+' : ''}${formatNumber(data.current, 1)}A` : '--'}</strong></div>
        <div><span>Temperature</span><i /><strong>{data ? `${formatNumber(data.temp1, 1)}C` : '--'}</strong></div>
      </div>
      <div className="trend-grid">
        <MetricTile label="Avg SOC" value={totalSoc !== null ? `${totalSoc}%` : '--'} />
        <MetricTile label="Net power" value={`${formatNumber(totalPower)}W`} />
      </div>
    </aside>
  )
}

export default function App() {
  const [packs, setPacks] = useState<PackMap>({})
  const [status, setStatus] = useState('Connecting...')
  const [now, setNow] = useState(Date.now())
  const [selectedView, setSelectedView] = useState('all')
  const clientRef = useRef<mqtt.MqttClient | null>(null)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const client = mqtt.connect(BROKER, {
      username: USERNAME,
      password: PASSWORD,
      reconnectPeriod: 5000,
    })
    clientRef.current = client

    client.on('connect', () => {
      setStatus('Connected')
      client.subscribe('jk-bms/sensor/#')
    })

    client.on('disconnect', () => setStatus('Disconnected'))
    client.on('error', (e) => setStatus(`Error: ${e.message}`))
    client.on('reconnect', () => setStatus('Reconnecting...'))

    client.on('message', (topic, payload) => {
      const parsed = parseSensorTopic(topic)
      const value = Number(payload.toString())
      if (!parsed?.pack || Number.isNaN(value)) return

      setPacks(prev => {
        const next = prev[parsed.pack] ? { ...prev[parsed.pack], cells: [...prev[parsed.pack].cells] } : emptyPack()
        if (parsed.field === 'cell' && parsed.cell !== undefined) {
          if (parsed.cell < 0 || parsed.cell >= CELLS_PER_PACK) return prev
          next.cells[parsed.cell] = value
        } else {
          const key = SENSOR_FIELDS[parsed.field]
          if (!key) return prev
          next[key] = value
        }
        next.updatedAt = Date.now()
        return { ...prev, [parsed.pack]: next }
      })
    })

    return () => { client.end() }
  }, [])

  const displayPacks = packs
  const livePacks = Object.values(displayPacks)
  const aggregatePack = buildAggregatePack(livePacks)
  const selectedPack = selectedView === 'all' ? 'all' : selectedView
  const selectedPackData = selectedView === 'all' ? aggregatePack : displayPacks[selectedPack]
  const totalSoc = livePacks.length
    ? Math.round(livePacks.reduce((sum, pack) => sum + pack.soc, 0) / livePacks.length)
    : null
  const totalPower = livePacks.reduce((sum, pack) => sum + pack.power, 0)
  const totalCurrent = livePacks.reduce((sum, pack) => sum + pack.current, 0)
  const averageVoltage = livePacks.length
    ? livePacks.reduce((sum, pack) => sum + pack.voltage, 0) / livePacks.length
    : null
  const totalCapacity = livePacks.reduce((sum, pack) => sum + pack.capacity, 0)
  const onlinePacks = PACKS.filter(name => displayPacks[name] && !isStale(displayPacks[name], now)).length
  const connectionTone = status === 'Connected' ? 'good' : status === 'Connecting...' || status === 'Reconnecting...' ? 'warning' : 'danger'
  const connectionLabel = status === 'Connected' ? 'MQTT connected' : status

  return (
    <main className="dashboard-shell">
      <HeaderBar status={connectionLabel} tone={connectionTone} now={now} />

      <BatteryDeck averageVoltage={averageVoltage} totalCurrent={totalCurrent} totalPower={totalPower} remainingAh={totalCapacity} />

      <section className="summary-grid" aria-label="Battery summary">
        <MetricTile label="Avg SOC" value={totalSoc !== null ? `${totalSoc}%` : '--'} helper="Across reporting packs" tone={totalSoc !== null && totalSoc < 20 ? 'danger' : 'good'} />
        <MetricTile label="Total battery power" value={`${totalPower > 0 ? '+' : ''}${formatNumber(totalPower)}W`} helper="From BMS pack power" />
        <MetricTile label="Remaining" value={`${formatNumber(totalCapacity, 1)}Ah / ${TOTAL_BATTERY_CAPACITY_AH}Ah`} helper="Remaining / total capacity" />
        <MetricTile label="Online packs" value={`${onlinePacks}/${PACKS.length}`} helper="Fresh within 120s" />
      </section>

      <PackComparison packs={displayPacks} now={now} selectedView={selectedView} onSelect={setSelectedView} />

      <div className="dashboard-grid">
        <PackPanel
          data={selectedPackData}
          name={selectedPack}
          now={now}
          onSelect={setSelectedView}
          selectedView={selectedView}
        />
        <div className="sidebar">
          <AlertsPanel packs={displayPacks} now={now} />
          <TrendsPanel data={selectedPackData} totalSoc={totalSoc} totalPower={totalPower} />
        </div>
      </div>
    </main>
  )
}

