// Copyright (c) 2026 OpenNVR
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A Live View tour running on a display board: the wall shows one page of a
 * tour's cameras, then the next, for ever (routers/tours.py, lib/tourPlan.ts).
 *
 * Kept apart from LiveView on purpose. Live View's grid is an operator's own
 * arrangement, saved in their browser; a tour never reads or writes it.
 *
 * Built for a screen nobody touches:
 * * moving the mouse does not pause it — pausing is a button (or Space), and
 *   a paused wall says so until it is resumed;
 * * tiles play the low-res substream, falling back to the main stream for a
 *   camera whose substream does not work, and remembering that for the rest
 *   of the session so later pages do not wait on it again;
 * * the next page's stream tokens are fetched a few seconds before it shows;
 * * edits to the tour reach a running wall within five minutes, and a failed
 *   fetch keeps showing the tour it has while it retries.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CameraOff, ChevronLeft, ChevronRight, Maximize, Minimize, Pause, Play, PauseCircle, Route, X } from 'lucide-react'
import { clsx } from 'clsx'
import { useTranslation } from '../i18n'
import { apiService } from '../lib/apiService'
import { rebaseToCurrentOrigin } from '../lib/streamUrl'
import { useCameras, type CameraItem } from '../lib/queries'
import { resolveLayout, type WindowLayoutSettings } from '../lib/liveLayouts'
import { buildPages, formatDuration, wrapIndex, type TourPage } from '../lib/tourPlan'
import type { Tour } from '../services/tourService'
import { useCameraStatus } from '../hooks/useCameraStatus'
import { useFullscreen } from '../hooks/useFullscreen'
import { usePageVisible } from '../hooks/usePageVisible'
import { VideoPlayer } from '../components/VideoPlayer'
import { cameraState, STATE_INK } from './dashboard/WidgetFrame'

/** The bar hides after this long without the mouse moving. */
const BAR_HIDE_MS = 3_000
/** Fetch the next page's stream tokens this long before it shows. */
const PREFETCH_LEAD_MS = 5_000
/** A substream that has not played after this long is treated as broken. */
const SUB_STALL_MS = 12_000
/** The stream token lives 60 minutes; reuse the info a little under that. */
const STREAM_STALE_MS = 45 * 60_000

/** Cameras whose substream failed this session: they start on the main stream. */
const NO_SUB = new Set<number>()

type StreamInfo = { urls?: { webrtc?: string; webrtc_sub?: string; hls?: string }; token?: string }

const streamKey = (cameraId: number) => ['tour-stream', cameraId] as const
const fetchStream = async (cameraId: number) => {
  const { data } = await apiService.getTourStreamInfo(cameraId)
  return data as StreamInfo
}

export function TourView() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { tourId } = useParams()
  const id = Number(tourId)
  const validId = Number.isInteger(id) && id > 0
  const visible = usePageVisible()
  const wallRef = useRef<HTMLDivElement>(null)
  const { toggle: toggleFs, isFullscreen } = useFullscreen(wallRef as RefObject<HTMLDivElement>)

  const tour = useQuery({
    queryKey: ['tour', id],
    enabled: validId,
    queryFn: async () => (await apiService.getTour(id)).data as Tour,
    // Edits reach a running wall without a reload; a failure retries sooner.
    refetchInterval: (q) => (q.state.status === 'error' ? 30_000 : 5 * 60_000),
    refetchIntervalInBackground: true,
    retry: (count, err: any) => err?.status !== 404 && count < 2,
  })
  const windowSettings = useQuery({
    queryKey: ['window-settings'],
    queryFn: async () => (await apiService.getWindowSettings()).data as WindowLayoutSettings,
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  })
  // Paused cameras too: a tour shows them as paused rather than dropping them.
  const cams = useCameras({ active_only: false })
  const camById = useMemo(() => new Map((cams.data?.cameras ?? []).map((c) => [c.id, c])), [cams.data])

  const layoutsReady = !windowSettings.isPending
  const pages = useMemo(
    () => (tour.data && layoutsReady ? buildPages(tour.data.steps, (lid) => resolveLayout(lid, windowSettings.data)) : []),
    [tour.data, layoutsReady, windowSettings.data],
  )
  // "Step 2 of 4" counts only the steps that have something to show.
  const stepOrdinal = useMemo(() => {
    const m = new Map<number, number>()
    for (const p of pages) if (!m.has(p.stepIndex)) m.set(p.stepIndex, m.size + 1)
    return m
  }, [pages])

  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const [spot, setSpot] = useState<number | null>(null)
  const current = pages.length ? Math.min(index, pages.length - 1) : 0
  const page: TourPage | undefined = pages[current]
  const pageKey = page?.key

  const go = useCallback((delta: number) => {
    setSpot(null)
    setIndex((i) => wrapIndex(Math.min(i, Math.max(0, pages.length - 1)), delta, pages.length))
  }, [pages.length])

  // A spotlit camera that is no longer on the page (the tour was edited) is let go.
  useEffect(() => {
    if (spot != null && page && !page.cameraIds.includes(spot)) setSpot(null)
  }, [spot, page])

  // The page timer. Time already spent on a page survives pausing, a hidden
  // tab and a refetch of the unchanged tour; only a new page starts from zero.
  const elapsed = useRef(0)
  useEffect(() => { elapsed.current = 0 }, [pageKey])
  const running = !!page && pages.length > 1 && !paused && visible && spot == null
  useEffect(() => {
    if (!running || !page) return
    const started = Date.now()
    const remaining = Math.max(0, page.durationMs - elapsed.current)
    const next = pages[wrapIndex(current, 1, pages.length)]
    const prefetch = window.setTimeout(() => {
      for (const cid of next.cameraIds) {
        qc.prefetchQuery({ queryKey: streamKey(cid), queryFn: () => fetchStream(cid), staleTime: STREAM_STALE_MS })
      }
    }, Math.max(0, remaining - PREFETCH_LEAD_MS))
    const advance = window.setTimeout(() => go(1), remaining)
    return () => {
      window.clearTimeout(prefetch)
      window.clearTimeout(advance)
      elapsed.current += Date.now() - started
    }
  }, [running, page, pages, current, go, qc])

  // The bar shows on mouse movement and hides again; it stays while paused.
  const [barShown, setBarShown] = useState(true)
  const hideTimer = useRef<number | undefined>(undefined)
  const poke = useCallback(() => {
    setBarShown(true)
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => setBarShown(false), BAR_HIDE_MS)
  }, [])
  useEffect(() => {
    poke()
    return () => window.clearTimeout(hideTimer.current)
  }, [poke])
  const barVisible = barShown || paused || spot != null

  const exitTour = useCallback(() => navigate('/live'), [navigate])
  const togglePause = useCallback(() => setPaused((p) => !p), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === ' ') { e.preventDefault(); togglePause() }
      else if (e.key === 'ArrowRight') go(1)
      else if (e.key === 'ArrowLeft') go(-1)
      else if (e.key === 'f' || e.key === 'F') toggleFs()
      else if (e.key === 'Escape') {
        // In fullscreen the browser takes Escape to leave it; out of it,
        // Escape lets go of a spotlit tile first, then leaves the tour.
        if (spot != null) setSpot(null)
        else if (!isFullscreen) exitTour()
      } else return
      poke()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, togglePause, toggleFs, exitTour, poke, spot, isFullscreen])

  const step = page && tour.data ? tour.data.steps[page.stepIndex] : undefined
  const hidden = step?.hidden_count ?? 0
  const pausedIds = useMemo(() => new Set(step?.paused_camera_ids ?? []), [step])

  let body: React.ReactNode
  if (!validId || (tour.isError && (tour.error as any)?.status === 404)) {
    body = (
      <WallMessage icon={<Route size={22} />} title={t('tours.notFound')}>
        <Link to="/live" className="text-xs px-2 py-1 border border-white/15 hover:bg-white/5">{t('tours.backToLive')}</Link>
      </WallMessage>
    )
  } else if (tour.isPending || !layoutsReady) {
    body = <div className="absolute inset-0 flex items-center justify-center"><div className="w-6 h-6 border-2 border-white/20 border-t-white/70 rounded-full animate-spin" /></div>
  } else if (!tour.data) {
    body = (
      <WallMessage icon={<AlertTriangle size={22} />} title={t('tours.loadFailed')} detail={t('tours.retrying')}>
        <button type="button" onClick={() => tour.refetch()} className="text-xs px-2 py-1 border border-white/15 hover:bg-white/5">{t('shared.retry')}</button>
      </WallMessage>
    )
  } else if (!tour.data.enabled) {
    body = <WallMessage icon={<PauseCircle size={22} />} title={t('tours.turnedOff')} detail={t('tours.turnedOffHint')} />
  } else if (!page) {
    body = <WallMessage icon={<CameraOff size={22} />} title={t('tours.nothingToShow')} detail={t('tours.nothingToShowHint')} />
  } else {
    const spotCam = spot
    const layout = spotCam != null ? { gridCols: 1, gridRows: 1, tiles: [{ row: 0, col: 0, rowSpan: 1, colSpan: 1 }] } : page.layout
    const ids = spotCam != null ? [spotCam] : page.cameraIds
    body = (
      <div
        className="absolute inset-0 grid gap-px bg-[#1a1f29]"
        style={{ gridTemplateColumns: `repeat(${layout.gridCols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${layout.gridRows}, minmax(0, 1fr))` }}
      >
        {layout.tiles.map((tile, i) => {
          const cid = ids[i]
          const area = { gridRow: `${tile.row + 1} / span ${tile.rowSpan}`, gridColumn: `${tile.col + 1} / span ${tile.colSpan}` }
          // Keyed by camera, so a camera on two pages in a row keeps playing.
          return cid != null ? (
            <div key={`cam-${cid}`} style={area} className="relative min-w-0 min-h-0">
              <TourTile
                cameraId={cid}
                cam={camById.get(cid)}
                pausedCamera={pausedIds.has(cid)}
                playing={visible}
                spotlit={spotCam === cid}
                onSpotlight={() => setSpot((s) => (s === cid ? null : cid))}
              />
            </div>
          ) : (
            <div key={`empty-${i}`} style={area} className="bg-black" />
          )
        })}
      </div>
    )
  }

  const pageLabel = page ? (step?.label || t('tours.stepN', { n: stepOrdinal.get(page.stepIndex) ?? 1 })) : ''

  return (
    <section className="flex flex-col h-[calc(100vh-5rem)] border border-[var(--border)] bg-black overflow-hidden">
      <div
        ref={wallRef}
        data-testid="tour-wall"
        className={clsx('relative flex-1 min-h-0 bg-black', !barVisible && 'cursor-none')}
        onMouseMove={poke}
      >
        {body}

        {/* Progress hairline: always there, so a guard can see the wall is turning. */}
        {page && pages.length > 1 && (
          <div className="pointer-events-none absolute top-0 inset-x-0 h-[2px] z-30 bg-white/5">
            <div
              key={pageKey}
              className="h-full bg-[var(--accent)] dash-tour-progress"
              style={{ animationDuration: `${page.durationMs}ms`, animationPlayState: running ? 'running' : 'paused' }}
            />
          </div>
        )}

        {/* The bar */}
        <div
          className={clsx(
            'absolute inset-x-0 top-0 z-20 flex items-center gap-2 px-3 pt-2 pb-6 text-white bg-gradient-to-b from-black/80 to-transparent transition-opacity duration-300',
            barVisible ? 'opacity-100' : 'opacity-0 pointer-events-none',
          )}
          onFocus={poke}
        >
          <Route size={14} className="shrink-0 text-white/70" aria-hidden="true" />
          <span className="text-sm font-semibold truncate" data-testid="tour-name">{tour.data?.name ?? ''}</span>
          {page && (
            <span className="flex items-center gap-2 min-w-0 text-xs text-white/75">
              <span aria-hidden="true">·</span>
              <span className="truncate font-medium text-white" data-testid="tour-step">{pageLabel}</span>
              <span className="font-mono tabular-nums whitespace-nowrap">
                {t('tours.stepOf', { n: stepOrdinal.get(page.stepIndex) ?? 1, total: stepOrdinal.size })}
                {page.pages > 1 && ` · ${t('tours.pageOf', { n: page.page + 1, total: page.pages })}`}
                {` · ${formatDuration(page.durationMs / 1000)}`}
              </span>
              {page.layoutFallback && (
                <span className="flex items-center gap-1 text-[var(--on-video-warn)]" title={t('tours.layoutMissingHint')}>
                  <AlertTriangle size={12} aria-hidden="true" />
                  <span className="hidden md:inline">{t('tours.layoutMissing')}</span>
                </span>
              )}
              {hidden > 0 && (
                <span className="hidden md:inline text-white/55 whitespace-nowrap">{t('tours.unavailable', { count: hidden })}</span>
              )}
            </span>
          )}
          <span className="ml-auto flex items-center gap-1 shrink-0">
            {pages.length > 1 && (
              <>
                <BarButton label={t('tours.previous')} onClick={() => go(-1)}><ChevronLeft size={15} /></BarButton>
                <BarButton label={paused ? t('tours.resume') : t('tours.pause')} onClick={togglePause} active={paused}>
                  {paused ? <Play size={14} /> : <Pause size={14} />}
                </BarButton>
                <BarButton label={t('tours.next')} onClick={() => go(1)}><ChevronRight size={15} /></BarButton>
                <span className="w-px h-4 bg-white/20 mx-1" aria-hidden="true" />
              </>
            )}
            <BarButton label={isFullscreen ? t('video.exitFullscreen') : t('live.fullscreen')} onClick={toggleFs}>
              {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
            </BarButton>
            <BarButton label={t('tours.exit')} onClick={exitTour}><X size={15} /></BarButton>
          </span>
        </div>

        {paused && page && pages.length > 1 && (
          <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-4 z-20 px-3 py-1 text-[11px] font-bold tracking-[0.2em] uppercase text-black bg-[var(--on-video-warn)]" role="status">
            {t('tours.pausedPill')}
          </div>
        )}
      </div>
    </section>
  )
}

function BarButton({ label, onClick, active = false, children }: { label: string; onClick: () => void; active?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={active || undefined}
      className={clsx('p-1.5 border', active ? 'border-white/60 bg-white/20' : 'border-white/15 bg-black/40 hover:bg-black/70')}
    >
      {children}
    </button>
  )
}

function WallMessage({ icon, title, detail, children }: { icon: React.ReactNode; title: string; detail?: string; children?: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-white/70">
      {icon}
      <div className="text-sm font-medium text-white/85">{title}</div>
      {detail && <div className="text-xs max-w-md">{detail}</div>}
      {children}
    </div>
  )
}

/**
 * One tour tile. Plays the substream when the server offers one and it
 * works; any failure of the substream that is not an expired token (which
 * only needs a fresh token) moves this camera to the main stream for the
 * rest of the session.
 */
function TourTile({ cameraId, cam, pausedCamera, playing, spotlit, onSpotlight }: {
  cameraId: number
  cam: CameraItem | undefined
  pausedCamera: boolean
  playing: boolean
  spotlit: boolean
  onSpotlight: () => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { version } = useCameraStatus(cameraId)
  const state = cam ? cameraState(cam) : 'degraded'
  const isPaused = pausedCamera || cam?.is_active === false
  const live = !isPaused && (state === 'online' || state === 'degraded')
  const [preferSub, setPreferSub] = useState(() => !NO_SUB.has(cameraId))

  const info = useQuery({
    queryKey: streamKey(cameraId),
    enabled: playing && live,
    queryFn: () => fetchStream(cameraId),
    staleTime: STREAM_STALE_MS,
    gcTime: 50 * 60_000,
  })

  const lastRefresh = useRef(0)
  const onAuthExpired = useCallback(() => {
    const now = Date.now()
    if (now - lastRefresh.current < 10_000) return
    lastRefresh.current = now
    qc.invalidateQueries({ queryKey: streamKey(cameraId) })
  }, [qc, cameraId])

  const sub = info.data?.urls?.webrtc_sub
  const usingSub = preferSub && !!sub
  const whep = rebaseToCurrentOrigin(usingSub ? sub : info.data?.urls?.webrtc)
  const hls = rebaseToCurrentOrigin(info.data?.urls?.hls)

  const dropSub = useCallback(() => {
    NO_SUB.add(cameraId)
    setPreferSub(false)
  }, [cameraId])
  const onError = useCallback((msg: string) => {
    if (!usingSub || cam?.live_online === false) return
    if (/WHEP connection failed: 40[013]\b/.test(msg)) return // expired token, not a broken path
    dropSub()
  }, [usingSub, cam?.live_online, dropSub])

  // Backstop for a substream that neither plays nor errors: give it a
  // while, then use the main stream.
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const box = boxRef.current
    if (!usingSub || !live || !playing || !box) return
    const timer = window.setTimeout(dropSub, SUB_STALL_MS)
    // Media events do not bubble, but they do pass through the capture phase.
    const onPlaying = () => window.clearTimeout(timer)
    box.addEventListener('playing', onPlaying, true)
    return () => {
      window.clearTimeout(timer)
      box.removeEventListener('playing', onPlaying, true)
    }
  }, [usingSub, live, playing, whep, version, dropSub])

  const name = cam?.name || t('tours.cameraN', { id: cameraId })

  return (
    <div ref={boxRef} className="group absolute inset-0 bg-black overflow-hidden" data-testid="tour-tile" data-camera-id={cameraId}>
      {live && playing && (whep || hls) ? (
        <VideoPlayer
          key={`${cameraId}-${version}-${usingSub ? 's' : 'm'}`}
          mode="live"
          chrome="none"
          whepUrl={whep}
          hlsUrl={hls}
          mediamtxToken={info.data?.token}
          onAuthExpired={onAuthExpired}
          onError={onError}
          preferredStreamType="webrtc"
          autoPlay
          muted
          displayAspectOverride={cam?.display_aspect_ratio}
          cameraId={cameraId}
          className="w-full h-full !bg-black"
        />
      ) : (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-white/45"
          style={{ background: 'repeating-linear-gradient(135deg, #07090d 0 10px, #0b0f16 10px 20px)' }}
        >
          {live ? (
            <div className="w-5 h-5 border-2 border-white/20 border-t-white/70 rounded-full animate-spin" />
          ) : (
            <>
              {isPaused ? <PauseCircle size={18} /> : <CameraOff size={18} />}
              <div className="text-[10px] font-mono uppercase tracking-[0.2em]">
                {isPaused ? t('tours.cameraPaused') : state === 'error' ? t('dashboard.statusError') : t('dashboard.statusOffline')}
              </div>
            </>
          )}
        </div>
      )}

      {/* Label band */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-black/75 to-transparent" />
      <div className="pointer-events-none absolute left-2 right-2 bottom-1.5 flex items-center gap-1.5 text-white">
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: isPaused ? 'var(--text-dim)' : STATE_INK[state] }} aria-hidden="true" />
        <span className="text-[11px] font-medium truncate [text-shadow:0_1px_2px_rgba(0,0,0,0.9)]" data-testid="tour-tile-name">{name}</span>
        {cam?.location && (
          <span className="shrink-0 text-[10px] text-white/60 truncate max-w-[40%] [text-shadow:0_1px_2px_rgba(0,0,0,0.9)]">{cam.location}</span>
        )}
      </div>

      {/* Click the picture to spotlight it (the tour waits), click again to return. */}
      <button
        type="button"
        onClick={onSpotlight}
        className="absolute inset-0 z-10 cursor-[inherit] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:-outline-offset-2"
        aria-label={spotlit ? t('dashboard.backToWall') : t('tours.spotlight', { name })}
        title={spotlit ? t('dashboard.backToWall') : t('tours.spotlight', { name })}
      />
    </div>
  )
}
