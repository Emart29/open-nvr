/**
 * Copyright (c) 2026 OpenNVR
 * This file is part of OpenNVR.
 * 
 * OpenNVR is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 * 
 * OpenNVR is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 * 
 * You should have received a copy of the GNU Affero General Public License
 * along with OpenNVR.  If not, see <https://www.gnu.org/licenses/>.
 */

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation, useDateFormat, type DateFormatters } from '../i18n'
import { useConfirm } from '../components/ui/ConfirmDialog'
import { apiService } from '../lib/apiService'
import { queryClient, useCameras, useMediaMtxHealth } from '../lib/queries'
import { useCameraStatusConnected } from '../hooks/useCameraStatus'
import { extractApiError } from '../lib/apiError'
import { useSnackbar } from '../components/Snackbar'
import { usePermissions } from '../hooks/usePermissions'
import { CameraOff, Pencil, Trash2, Unplug, Video } from 'lucide-react'
import { Badge, Button, EmptyState, PageHeader, Skeleton, Table, THead, TBody, TR, TH, TD } from '../components/ui'
import { Checkbox, Field, Input, Select } from '../components/ui/form'
import { FilterBar, IconButton } from '../components/ui/layout'
import { Pagination } from '../components/ui/Pagination'
import type { BadgeVariant } from '../components/ui'
import { AddCameraDialog } from '../components/AddCameraDialog'
import { QrScanner } from '../components/QrScanner'
import { parseCameraQr } from '../lib/cameraQr'
import { ASPECT_OPTIONS, isCustomAspect } from '../lib/aspect'
import { parseRtspUrl, rtspPortFromUrl, syncCameraIdentity } from '../lib/cameraIdentity'
import type { IdentityField } from '../lib/cameraIdentity'
import { formatDuration } from '../lib/time'
import { Modal } from '../components/Modal'

// Per-camera capability assignment ("camera 1 does LPR") — slice 1 of
// docs/design/per-camera-assignment.md. Written only here (the camera
// settings surface); consumers read it from the internal endpoint.
type CameraAssignment = { skill: string; labels?: string[] | null }

type Camera = {
  id: number
  name: string
  description?: string | null
  ip_address: string
  port: number
  username?: string | null
  password?: string | null
  rtsp_url?: string | null
  substream_url?: string | null
  /** Display-only aspect override; null = auto-detect. See lib/aspect.ts. */
  display_aspect_ratio?: string | null
  location?: string | null
  vlan?: string | null
  status?: string | null
  owner_id: number
  is_active: boolean
  // Tier-0 object detection; false = off (e.g. switched off from Home
  // Assistant). The camera keeps streaming and recording either way.
  detection_enabled?: boolean
  deleted_at?: string | null
  mediamtx_provisioned?: boolean | null
  // Live connectivity as tracked by the recorder (MediaMTX path ready AND
  // bytes flowing). null/undefined means UNKNOWN — not offline. See
  // streamState below for why that distinction has to survive to the badge.
  live_online?: boolean | null
  // Configuration intent — always true for a provisioned camera and not
  // switchable, so it says nothing about whether footage is being written.
  recording_enabled?: boolean | null
  // Observed recording health, derived server-side from the newest indexed
  // segment. Absent (undefined) means the endpoint didn't compute it.
  recording_state?: 'recording' | 'not_recording' | 'stalled' | 'never' | 'off' | null
  last_recording_at?: string | null
  // ONVIF device metadata
  manufacturer?: string | null
  model?: string | null
  firmware_version?: string | null
  serial_number?: string | null
  hardware_id?: string | null
  assignments?: CameraAssignment[] | null
}

/** Which preset the stored display-aspect value corresponds to. A stored
 *  ratio that isn't one of the presets lands on 'custom'. */
function aspectChoiceOf(stored: string | null | undefined): string {
  if (!stored) return 'auto'
  if (isCustomAspect(stored)) return 'custom'
  return stored
}

/** The value to persist: null means "auto", which is how the API and the DB
 *  both spell "no override". */
function aspectValueOf(form: CameraForm): string | null {
  const choice = form.display_aspect_choice || 'auto'
  if (choice === 'auto') return null
  if (choice === 'custom') return form.display_aspect_custom?.trim() || null
  return choice
}

type CameraForm = {
  name: string
  description?: string
  ip_address: string
  port: number
  username?: string
  password?: string
  rtsp_url?: string
  substream_url?: string
  /** Preset key: 'auto' | 'native' | '16:9' | '4:3' | 'custom'. */
  display_aspect_choice?: string
  /** Free-form "W:H", only meaningful while display_aspect_choice is 'custom'. */
  display_aspect_custom?: string
  location?: string
  vlan?: string
  status?: string
  is_active?: boolean
  detection_enabled?: boolean
}

export function Cameras() {
  const fmt = useDateFormat()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { hasPermission } = usePermissions()
  const canManageCameras = hasPermission('cameras.manage')
  const { showError, showSuccess, showInfo, showWarning } = useSnackbar()
  const confirm = useConfirm()
  // A mutation (delete / bulk op) is in flight. Distinct from the list's own
  // fetching state: the list now refreshes on its own in the background, and
  // that must never disable the buttons.
  const [mutating, setMutating] = useState(false)
  const [activeOnly, setActiveOnly] = useState(true)
  const [limit, setLimit] = useState(20)
  const [page, setPage] = useState(1)
  const skip = useMemo(() => (page - 1) * limit, [page, limit])
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const liveUpdates = useCameraStatusConnected()

  // One request per pause in typing, not one per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 250)
    return () => clearTimeout(t)
  }, [query])

  const camsQuery = useCameras({
    skip,
    limit,
    active_only: activeOnly,
    q: debouncedQuery || undefined,
  })
  const cameras = useMemo<Camera[]>(
    () => (camsQuery.data?.cameras ?? []) as Camera[],
    [camsQuery.data],
  )
  const total = camsQuery.data?.total ?? 0

  const mtxQuery = useMediaMtxHealth()
  // null while we genuinely don't know yet — the "Media Server is not running"
  // banner must not flash during the first round trip.
  const mediamtxAvailable = mtxQuery.isPending ? null : mtxQuery.data?.status === 'ok'

  useEffect(() => {
    if (camsQuery.isError) {
      showError(extractApiError(camsQuery.error, t('dashboard.failedCameras')))
    }
  }, [camsQuery.isError, camsQuery.error, showError, t])

  // A selection is scoped to what is currently listed, so changing the listing
  // drops it. Deliberately keyed on the view parameters and not on the data:
  // the list refetches itself every minute now, and wiping a half-made
  // selection on a background refresh would be maddening.
  useEffect(() => {
    setSelected(new Set())
  }, [skip, limit, activeOnly, debouncedQuery])

  // Bulk assign state
  const [showBulkAssign, setShowBulkAssign] = useState(false)
  const [bulkUserId, setBulkUserId] = useState<number | ''>('')
  const [userQuery, setUserQuery] = useState('')
  const [userOptions, setUserOptions] = useState<Array<{ id: number; username: string; email: string; is_active: boolean }>>([])
  const [usersLoading, setUsersLoading] = useState(false)
  const [bulkCanView, setBulkCanView] = useState(true)
  const [bulkCanManage, setBulkCanManage] = useState(false)

  // Edit/Create state
  const [editing, setEditing] = useState<Camera | null>(null)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [showEditDialog, setShowEditDialog] = useState(false)
  // Dedicated to the edit form, so a delete elsewhere on the page cannot
  // disable the Update button and make it look broken.
  const [saving, setSaving] = useState(false)
  const [scanQr, setScanQr] = useState(false)

  const [form, setForm] = useState<CameraForm>({
    name: '',
    description: '',
    ip_address: '',
    port: 554,
    username: '',
    password: '',
    rtsp_url: '',
    substream_url: '',
    display_aspect_choice: 'auto',
    display_aspect_custom: '',
    location: '',
    vlan: '',
    status: 'unknown',
  })

  const resetForm = () => setForm({
    name: '',
    description: '',
    ip_address: '',
    port: 554,
    username: '',
    password: '',
    rtsp_url: '',
    substream_url: '',
    display_aspect_choice: 'auto',
    display_aspect_custom: '',
    location: '',
    vlan: '',
    status: 'unknown',
  })

  // Observed stream state. `live_online` is tracked by the recorder off
  // MediaMTX's ready/not-ready hooks and arrives on the camera row itself —
  // this used to cost one /mediamtx-status probe per camera per page load,
  // three MediaMTX round trips each, and still went stale the moment a camera
  // dropped because nothing refetched it.
  const streamState = (c: Camera): { variant: BadgeVariant; label: string; title?: string; icon?: boolean } => {
    if (mediamtxAvailable === false) {
      return { variant: 'warning', label: 'Disconnected', title: 'Media Server is not running', icon: true }
    }
    // A paused camera has no path at all, so it is neither live nor broken.
    // Checked before the unknown case below, which it would otherwise fall
    // into and sit on "Checking…" forever.
    if (!c.is_active) {
      return { variant: 'neutral', label: '—', title: 'Camera is paused' }
    }
    if (c.live_online === true) return { variant: 'success', label: 'Ready' }
    if (c.live_online === false) {
      return { variant: 'warning', label: 'Disconnected', title: 'Stream not receiving data' }
    }
    // Unknown, NOT offline: the recorder keeps this state in memory and
    // re-seeds it a short while after starting. Claiming "Disconnected" here
    // would show the whole fleet as down every time the server restarts.
    if (c.mediamtx_provisioned === true) {
      return { variant: 'neutral', label: 'Checking…', title: 'Live state not yet known' }
    }
    if (c.mediamtx_provisioned === false) return { variant: 'destructive', label: 'Error' }
    return { variant: 'neutral', label: 'Not configured' }
  }

  // Observed recording health, not the config flag. `recording_enabled` is
  // true for every provisioned camera and cannot be switched off, so it used
  // to claim "Recording" beside a dead stream. The server derives this from
  // the newest written segment and the stream's live state, using the
  // recording watchdog's own thresholds, so this badge agrees both with the
  // stall alert and with the Stream column beside it.
  const recordingState = (c: Camera): { variant: BadgeVariant; label: string; title?: string } => {
    const at = c.last_recording_at ? new Date(c.last_recording_at) : null
    const agoSeconds = at ? Math.max(0, (Date.now() - at.getTime()) / 1000) : null
    const seenAt = at ? `Last segment ${fmt.dateTime(at)}` : undefined

    switch (c.recording_state) {
      case 'recording':
        return { variant: 'success', label: 'Recording', title: seenAt }
      case 'not_recording':
        // The source is down but the last segment is too recent for the
        // watchdog to call it stalled. Saying "Recording" here is what put
        // this badge in direct contradiction with a Disconnected stream.
        return {
          variant: 'warning',
          label: 'Not recording',
          title: seenAt ? `${seenAt} — stream is down, nothing is being written` : 'Stream is down, nothing is being written',
        }
      case 'stalled': {
        // formatDuration never rolls up to days, so a multi-day stall would
        // render "Stalled 74h 12m" and overflow the column.
        const age =
          agoSeconds === null ? null : agoSeconds >= 86400 ? '>24h' : formatDuration(agoSeconds)
        return {
          variant: 'warning',
          label: age ? `Stalled ${age}` : 'Stalled',
          title: seenAt ? `${seenAt} — nothing written since` : undefined,
        }
      }
      case 'never':
        return { variant: 'warning', label: 'No data', title: 'No recording has ever been indexed for this camera' }
      case 'off':
        return { variant: 'neutral', label: 'Off' }
      default:
        // Endpoints that don't compute it leave this unset — say so rather
        // than implying recording is off.
        return { variant: 'neutral', label: '—', title: 'Recording state unavailable' }
    }
  }

  // User search for bulk assign
  useEffect(() => {
    let alive = true
    const run = async () => {
      if (!userQuery) { setUserOptions([]); return }
      try {
        setUsersLoading(true)
        const { data } = await apiService.getUsers({ q: userQuery, limit: 10, active_only: true })
        const list = Array.isArray(data.users) ? data.users : data
        if (alive) setUserOptions(list)
      } catch {
        if (alive) setUserOptions([])
      } finally {
        if (alive) setUsersLoading(false)
      }
    }
    const t = setTimeout(run, 250)
    return () => { alive = false; clearTimeout(t) }
  }, [userQuery])

  // Every mutation funnels through here. Invalidating the key rather than
  // refetching this component's params keeps the Dashboard's copy of the list
  // honest too, since both read the same cache.
  const refreshCameras = () =>
    queryClient.invalidateQueries({ queryKey: ['cameras'] })

  // A camera's address, port and credentials live twice over: in these fields
  // and again inside the RTSP URL. Re-sync when the operator leaves a control
  // rather than on every keystroke — mid-type, "192.168.1." is not a host and a
  // half-pasted URL is unparseable, so syncing per character would fight them.
  const syncIdentity = (changed: IdentityField) =>
    setForm((prev) => syncCameraIdentity(prev, changed))

  // The URL's host when it contradicts the IP field, else null. Drives the
  // warning under the URL input.
  const urlHostMismatch = useMemo(() => {
    const host = parseRtspUrl(form.rtsp_url)?.hostname
    return host && form.ip_address && host !== form.ip_address ? host : null
  }, [form.rtsp_url, form.ip_address])

  const onUpdate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editing) return
    try {
      setSaving(true)
      const payload: any = {
        name: form.name,
        description: form.description || null,
        ip_address: form.ip_address,
        port: Number(form.port) || undefined,
        username: form.username || null,
        ...(form.password ? { password: form.password } : {}),
        rtsp_url: form.rtsp_url || null,
        substream_url: form.substream_url || null,
        display_aspect_ratio: aspectValueOf(form),
        location: form.location || null,
        vlan: form.vlan || null,
        status: form.status || undefined,
        is_active: form.is_active,
        detection_enabled: form.detection_enabled !== false,
      }
      Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k])
      const { data } = await apiService.updateCamera(editing.id, payload)
      setShowEditDialog(false)
      setEditing(null)
      resetForm()
      await refreshCameras()
      // A changed stream source is pushed to the media server before the edit
      // is committed, so reaching here means it landed. stream_warning only
      // ever carries a best-effort pause/resume hiccup — the row is saved
      // either way. A failed re-point never gets here: it throws 409/502 and
      // nothing was written.
      if (data?.stream_warning) {
        showWarning(`Camera saved, but ${data.stream_warning}`)
      } else if (data?.stream_action && data.stream_action !== 'none') {
        showSuccess('Camera updated — stream re-provisioned')
      } else {
        showSuccess('Camera updated')
      }
    } catch (e: any) {
      showError(extractApiError(e, 'Failed to update camera'))
    } finally {
      setSaving(false)
    }
  }

  const onDelete = async (c: Camera) => {
    if (!(await confirm({
      title: t('camera.confirmDeleteTitle', { name: c.name }),
      message: t('camera.confirmDeleteMessage'),
      confirmLabel: t('camera.delete'),
      danger: true,
    }))) return
    try {
      setMutating(true)
      await apiService.deleteCamera(c.id)
      await refreshCameras()
      showSuccess('Camera deleted')
    } catch (e: any) {
      showError(extractApiError(e, 'Failed to delete camera'))
    } finally {
      setMutating(false)
    }
  }

  const onBulkDelete = async () => {
    const ids = Array.from(selected)
    if (!ids.length) return
    if (!(await confirm({
      title: t('camera.confirmBulkDeleteTitle', { count: ids.length }),
      message: t('camera.confirmBulkDeleteMessage'),
      confirmLabel: t('camera.delete'),
      danger: true,
    }))) return
    try {
      setMutating(true)
      // Per-camera failures used to be swallowed and the toast said
      // "completed" regardless; count them and say which way it went.
      let failed = 0
      for (const id of ids) {
        try { await apiService.deleteCamera(id) } catch { failed++ }
      }
      await refreshCameras()
      setSelected(new Set())
      if (failed) showError(t('camera.bulkPartial', { failed, total: ids.length }))
      else showSuccess('Bulk delete completed')
    } catch (e: any) {
      showError(extractApiError(e, 'Bulk delete failed'))
    } finally {
      setMutating(false)
    }
  }

  const onBulkAssign = async () => {
    const ids = Array.from(selected)
    if (!ids.length || bulkUserId === '') return
    try {
      setMutating(true)
      let failed = 0
      for (const id of ids) {
        try {
          await apiService.assignCameraPermission(id, { user_id: Number(bulkUserId), can_view: bulkCanView, can_manage: bulkCanManage })
        } catch { failed++ }
      }
      setShowBulkAssign(false)
      setSelected(new Set())
      if (failed) showError(t('camera.bulkPartial', { failed, total: ids.length }))
      else showSuccess('Bulk assign completed')
    } catch (e: any) {
      showError(extractApiError(e, 'Bulk assign failed'))
    } finally {
      setMutating(false)
    }
  }

  const startEdit = (c: Camera) => {
    setEditing(c)
    setShowCreateDialog(false)
    setForm({
      name: c.name,
      description: c.description || '',
      ip_address: c.ip_address,
      // Seed from the URL when it has a port: the server derives the column
      // from the URL on save regardless, so this is what will be stored — the
      // box may as well show it rather than a value about to be overwritten.
      port: rtspPortFromUrl(c.rtsp_url) ?? c.port,
      username: c.username || '',
      password: '',
      rtsp_url: c.rtsp_url || '',
      substream_url: c.substream_url || '',
      display_aspect_choice: aspectChoiceOf(c.display_aspect_ratio),
      display_aspect_custom: isCustomAspect(c.display_aspect_ratio)
        ? (c.display_aspect_ratio as string)
        : '',
      location: c.location || '',
      vlan: c.vlan || '',
      status: c.status || 'unknown',
      is_active: c.is_active,
      detection_enabled: c.detection_enabled !== false,
    })
    setShowEditDialog(true)
  }

  const closeEditDialog = () => {
    setShowEditDialog(false)
    setEditing(null)
    resetForm()
  }

  const hasNext = cameras.length === limit

  return (
    <section className="space-y-4">
      {/* Header */}
      <PageHeader
        title={t('nav.cameras')}
        description={t('camera.description')}
        actions={
          <div className="flex items-center gap-3">
            {/* Say so when pushed updates have stopped. The list still
                refreshes on its own timer, so the badges are not frozen —
                but they are no longer near-instant, and a status page that
                hides that is worse than one that admits it. */}
            {!liveUpdates && (
              <span className="text-xs text-[var(--text-dim)]" title="Reconnecting to the live event stream; status may lag by up to a minute">
                {t('dashboard.reconnecting')}
              </span>
            )}
            {canManageCameras && (
              <Button variant="primary" onClick={() => { setShowCreateDialog(true); setEditing(null); resetForm() }}>
                {t('camera.add')}
              </Button>
            )}
          </div>
        }
      />

      {/* Filters. Bulk actions appear here only with a selection, so the row
          stays quiet in the common case. */}
      <FilterBar
        actions={canManageCameras && selected.size > 0 ? (
          <>
            <Button size="sm" variant="danger" onClick={onBulkDelete} disabled={mutating}>
              Delete Selected ({selected.size})
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowBulkAssign((s) => !s)} disabled={mutating}>
              Assign Permissions
            </Button>
          </>
        ) : undefined}
      >
        <Input
          className="w-56"
          placeholder={t('camera.search')}
          value={query}
          onChange={(e) => { setPage(1); setQuery(e.target.value) }}
        />
        <Checkbox
          label={t('camera.activeOnly')}
          checked={activeOnly}
          onChange={(e) => { setPage(1); setActiveOnly(e.target.checked) }}
        />
      </FilterBar>

      {/* Bulk Assign Panel */}
      {canManageCameras && showBulkAssign && selected.size > 0 && (
        <div className="border border-[var(--border)] bg-[var(--panel-2)] p-3 text-sm flex items-center gap-3 flex-wrap">
          <div className="text-[var(--text-dim)]">Assign to user</div>
          <div className="relative">
            <Input
              className="w-56"
              placeholder="Type username or email"
              value={userQuery}
              onChange={(e) => { setUserQuery(e.target.value); setBulkUserId('') }}
            />
            {userQuery && (
              <div className="absolute z-10 mt-1 w-full bg-[var(--panel)] border border-[var(--border)] max-h-56 overflow-auto">
                {usersLoading ? (
                  <div className="px-2 py-1 text-[var(--text-dim)]">Searching…</div>
                ) : userOptions.length === 0 ? (
                  <div className="px-2 py-1 text-[var(--text-dim)]">No users</div>
                ) : (
                  userOptions.map(u => (
                    <button
                      type="button"
                      key={u.id}
                      className={`block w-full text-left px-2 py-1 hover:bg-[var(--panel-2)] ${bulkUserId === u.id ? 'bg-[var(--panel-2)]' : ''}`}
                      onClick={() => { setBulkUserId(u.id); setUserQuery(u.username) }}
                    >
                      <span className="text-[var(--text)]">{u.username}</span>
                      <span className="text-[var(--text-dim)]"> · {u.email}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          <Checkbox label={t('camera.canView')} checked={bulkCanView} onChange={(e) => setBulkCanView(e.target.checked)} />
          <Checkbox label={t('camera.canManage')} checked={bulkCanManage} onChange={(e) => setBulkCanManage(e.target.checked)} />
          <Button size="sm" variant="primary" onClick={onBulkAssign} disabled={mutating || bulkUserId === ''}>Apply to {selected.size} selected</Button>
          <Button size="sm" variant="outline" onClick={() => setShowBulkAssign(false)}>Cancel</Button>
        </div>
      )}

      {/* Create Camera Dialog — shared with Live View (discover / manual) */}
      {canManageCameras && showCreateDialog && (
        <AddCameraDialog
          title="Add New Camera"
          onClose={() => { setShowCreateDialog(false); resetForm() }}
          onCameraAdded={async () => { setShowCreateDialog(false); resetForm(); await refreshCameras() }}
        />
      )}

      {/* Cameras table. table-fixed with explicit widths is what keeps this
          from ever scrolling sideways: the fixed columns come to ~560px and
          Camera absorbs the rest, so content length no longer drives layout.
          Anything too long truncates and reveals in full via title. */}
      {/* Skeletons only on a cold load — `isPending` is true only when there
          is nothing cached to show. Every later fetch (a page change, the
          debounced re-search, the background refresh) keeps the previous rows
          on screen and just dims them, because swapping a populated table for
          skeletons flashes the whole page. */}
      {camsQuery.isPending ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
        </div>
      ) : cameras.length === 0 ? (
        <EmptyState
          icon={<CameraOff size={28} />}
          title={t('camera.noCamerasTitle')}
          description={query || activeOnly
            ? t('camera.noMatch')
            : t('camera.addAction')}
          action={canManageCameras ? (
            <Button variant="primary" onClick={() => { setShowCreateDialog(true); setEditing(null); resetForm() }}>
              {t('camera.addAction')}
            </Button>
          ) : undefined}
        />
      ) : (
        /* min-w is the floor, not the target. The fixed columns take ~570px,
           so below roughly 760px of table area the Camera column would be
           squeezed to nothing; past that point letting the wrapper scroll is
           the lesser evil. At any normal window width the table fits and no
           scrollbar appears. */
        <Table className={`table-fixed min-w-[760px] ${camsQuery.isFetching || mutating ? 'opacity-60 transition-opacity' : 'transition-opacity'}`}>
          <THead>
            <TR>
              <TH className="w-10">
                <input
                  type="checkbox"
                  className="accent-[var(--accent)]"
                  checked={cameras.length > 0 && cameras.every(c => selected.has(c.id))}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setSelected(new Set(cameras.map(c => c.id)))
                    } else {
                      setSelected(new Set())
                    }
                  }}
                />
              </TH>
              <TH>{t('nav.cameras')}</TH>
              <TH className="w-[170px]">{t('camera.address')}</TH>
              <TH className="w-[150px]">{t('camera.stream')}</TH>
              <TH className="w-[150px]">{t('camera.recording')}</TH>
              <TH className="w-[110px]">{t('camera.actions')}</TH>
            </TR>
          </THead>
          <TBody striped>
            {cameras.map((c) => {
              const stream = streamState(c)
              const rec = recordingState(c)
              // Model and serial lost their own columns; keep every field
              // reachable from the hover text rather than dropping it.
              const device = [c.manufacturer, c.model].filter(Boolean).join(' ')
              const deviceLine = [device, c.firmware_version].filter(Boolean).join(' · ')
              const deviceTitle = [c.manufacturer, c.model, c.serial_number, c.firmware_version]
                .filter(Boolean).join(' · ')
              return (
                <TR key={c.id} className={c.is_active ? undefined : 'opacity-60'}>
                  <TD>
                    <input
                      type="checkbox"
                      className="accent-[var(--accent)]"
                      checked={selected.has(c.id)}
                      onChange={(e) => {
                        const next = new Set(selected)
                        if (e.target.checked) next.add(c.id); else next.delete(c.id)
                        setSelected(next)
                      }}
                    />
                  </TD>
                  <TD className="truncate">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium" title={c.name}>{c.name}</span>
                      {/* The Active column is gone, so with "Active only"
                          unticked this badge is the only thing distinguishing
                          a deactivated camera. */}
                      {!c.is_active && <Badge variant="neutral" className="shrink-0">{t('common.inactive')}</Badge>}
                      {c.is_active && c.detection_enabled === false && (
                        <Badge variant="warning" className="shrink-0" title={t('cameras.detectionOffHint')}>{t('cameras.detectionOff')}</Badge>
                      )}
                    </div>
                    <div className="text-xs text-[var(--text-dim)] truncate" title={deviceTitle || undefined}>
                      {deviceLine || '—'}
                    </div>
                  </TD>
                  <TD className="whitespace-nowrap truncate" title={`${c.ip_address}:${c.port}`}>
                    {c.ip_address}<span className="text-[var(--text-dim)]">:{c.port}</span>
                  </TD>
                  <TD>
                    <Badge variant={stream.variant} title={stream.title}>
                      {stream.icon && <Unplug size={12} />}
                      {stream.label}
                    </Badge>
                  </TD>
                  <TD>
                    <Badge variant={rec.variant} title={rec.title}>{rec.label}</Badge>
                  </TD>
                  <TD>
                    <div className="flex items-center justify-end gap-1">
                      {canManageCameras && (
                        <IconButton variant="outline" onClick={() => startEdit(c)} title={t('camera.edit')} label={`${t('camera.edit')} ${c.name}`}>
                          <Pencil size={15} />
                        </IconButton>
                      )}
                      {/* Recording is automatic on an NVR — no manual
                          start/stop control. The Recording column shows its
                          live status, derived from the newest written
                          segment rather than the config flag. */}
                      {c.mediamtx_provisioned === true && (
                        <IconButton
                          variant="outline"
                          className="!text-[var(--accent)] !border-[color-mix(in_oklab,var(--accent)_50%,var(--border))]"
                          onClick={() => navigate(`/live?camera=${c.id}`)}
                          title={t('camera.viewLive')}
                          label={`View ${c.name} live`}
                        >
                          <Video size={15} />
                        </IconButton>
                      )}
                      {canManageCameras && (
                        <IconButton
                          variant="outline"
                          className="hover:!text-[var(--danger)] hover:!border-[var(--danger)]"
                          onClick={() => onDelete(c)}
                          title={t('camera.delete')}
                          label={`Delete ${c.name}`}
                        >
                          <Trash2 size={15} />
                        </IconButton>
                      )}
                    </div>
                  </TD>
                </TR>
              )
            })}
          </TBody>
        </Table>
      )}

      {/* activeOnly filters client-side of the count the backend returns, so
          the total would lie -- pass none and let the hasNext probe decide. */}
      <Pagination
        page={page}
        pageSize={limit}
        total={activeOnly ? undefined : total}
        hasNext={hasNext}
        rowCount={cameras.length}
        pageSizeOptions={[10, 20, 50]}
        onPageChange={setPage}
        onPageSizeChange={(n) => { setPage(1); setLimit(n) }}
        isFetching={camsQuery.isFetching}
        label={t('camera.camerasNoun')}
      />

      {/* Edit Camera Dialog */}
      {canManageCameras && showEditDialog && editing && (
        <Modal
          open={showEditDialog}
          title={`Edit camera — ${editing.name}`}
          onClose={closeEditDialog}
          widthClassName="w-[640px]"
        >
          <form onSubmit={onUpdate} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Name">
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </Field>
              <Field label="IP address">
                <Input value={form.ip_address} onChange={(e) => setForm({ ...form, ip_address: e.target.value })} onBlur={() => syncIdentity('ip_address')} required />
              </Field>
              {/* Editable again: a port typed here is no longer discarded — it
                  is written into the RTSP URL on blur, which is what MediaMTX
                  actually pulls. The URL still wins on save, so the two cannot
                  drift apart the way they used to. */}
              <Field label="Port">
                <Input
                  type="number"
                  value={form.port}
                  onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
                  onBlur={() => syncIdentity('port')}
                  min={1}
                  max={65535}
                  title="Kept in step with the port in the RTSP URL below"
                />
              </Field>
              <Field label="Username">
                <Input value={form.username || ''} onChange={(e) => setForm({ ...form, username: e.target.value })} onBlur={() => syncIdentity('username')} />
              </Field>
              <Field label="Password">
                <Input type="password" value={form.password || ''} onChange={(e) => setForm({ ...form, password: e.target.value })} onBlur={() => syncIdentity('password')} placeholder="Leave blank to keep existing" />
              </Field>
              <Field label="Location">
                <Input value={form.location || ''} onChange={(e) => setForm({ ...form, location: e.target.value })} />
              </Field>
              <Field label="VLAN">
                <Input value={form.vlan || ''} onChange={(e) => setForm({ ...form, vlan: e.target.value })} />
              </Field>
              <Field label="Description">
                <Input value={form.description || ''} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </Field>
            </div>

            <Field label="RTSP URL">
              {(id, describedBy) => (
                <div className="flex gap-2">
                  <Input id={id} aria-describedby={describedBy} className="flex-1" value={form.rtsp_url || ''} onChange={(e) => setForm({ ...form, rtsp_url: e.target.value })} onBlur={() => syncIdentity('rtsp_url')} />
                  <Button size="sm" variant="outline" className="whitespace-nowrap" onClick={() => setScanQr(true)} title="Scan the QR from the OpenNVR Cam app">Scan QR</Button>
                </div>
              )}
            </Field>
            {/* A camera saved before the fields were kept in step can open with
                the two already disagreeing. Say so rather than picking a winner:
                which one is stale is not knowable from here — a camera can be
                streaming perfectly from the URL's host while the IP column holds
                the wrong address, and silently "fixing" that would kill it. */}
            {urlHostMismatch && (
              <p className="text-xs text-[var(--warn)] -mt-2">
                The IP address ({form.ip_address}) and the RTSP URL host ({urlHostMismatch}) disagree.
                Editing either field updates the other — change the one that is wrong.
              </p>
            )}
            <Field label="Substream URL">
              <Input value={form.substream_url || ''} onChange={(e) => setForm({ ...form, substream_url: e.target.value })} placeholder="Optional low-res feed for the camera agent's live view" />
            </Field>

            {/* Display only — it never re-encodes and never re-provisions the
                stream. Auto covers encoders that squash the picture and signal
                no aspect ratio (Dahua/CP Plus "1080N" = 960x1080 for a 16:9
                scene); Native is the escape hatch if detection guesses wrong. */}
            <Field label="Display aspect ratio">
              {(id) => (
              <div className="space-y-1">
                <Select
                  id={id}
                  value={form.display_aspect_choice || 'auto'}
                  onChange={(e) => setForm({ ...form, display_aspect_choice: e.target.value })}
                >
                  {ASPECT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </Select>
                {form.display_aspect_choice === 'custom' && (
                  <Input
                    value={form.display_aspect_custom || ''}
                    onChange={(e) => setForm({ ...form, display_aspect_custom: e.target.value })}
                    placeholder="e.g. 16:9"
                  />
                )}
                <p className="text-xs text-[var(--muted)]">
                  How OpenNVR shows this camera. Display only — recordings are
                  stored exactly as the camera sends them.
                </p>
              </div>
              )}
            </Field>

            <Field label="Skills">
              {() => (
              <div className="space-y-2">
                {/* Skills follow apps: a camera carries exactly the model
                    skills the enabled apps using it bring, so there is
                    nothing to edit here — only who uses it, and what that
                    brings. To run a skill on this camera, select the camera
                    on the app's own page (Applications → the app → Configure). */}
                <p className="text-xs text-[var(--muted)]">
                  Skills come from apps. Select this camera in an app's
                  page (Applications → the app → Configure → Cameras) to run
                  that app's skills on it; disable the app to stop them.
                </p>
                <CameraUsedBy cameraId={editing.id} />
                {(editing.assignments || []).length > 0 && (
                  <p className="text-xs text-[var(--muted)]">
                    Currently: {(editing.assignments || []).map(a => a.skill).join(', ')}
                  </p>
                )}
              </div>
              )}
            </Field>

            <div className="flex flex-col gap-2">
              <Checkbox label="Active" checked={!!form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
              <Checkbox
                label={t('cameras.detectionEnabled')}
                hint={t('cameras.detectionOffHint')}
                checked={form.detection_enabled !== false}
                onChange={(e) => setForm({ ...form, detection_enabled: e.target.checked })}
              />
            </div>

            <div className="flex justify-end gap-2 border-t border-[var(--border)] pt-4">
              <Button variant="outline" onClick={closeEditDialog}>Cancel</Button>
              <Button type="submit" variant="primary" disabled={saving}>{saving ? 'Updating…' : 'Update camera'}</Button>
            </div>
          </form>

          {scanQr && (
            <QrScanner
              title="Scan the QR from the OpenNVR Cam app"
              onResult={(text) => {
                // Same unpacking as the add dialog: the scanned rtsp:// URL
                // carries host, port and credentials, so fill those fields
                // instead of leaving them for the operator to retype. The
                // name of a camera being edited is never overwritten.
                const scanned = parseCameraQr(text)
                setForm(f => ({
                  ...f,
                  ...scanned,
                  name: f.name.trim() || scanned.name || f.name,
                }))
                setScanQr(false)
              }}
              onClose={() => setScanQr(false)}
            />
          )}
        </Modal>
      )}
    </section>
  )
}


/** Read-only: the apps that picked this camera. Picks are made in each
 *  app's own configuration; this answers "what is this camera used for"
 *  from the camera's side. */
function CameraUsedBy({ cameraId }: { cameraId: number }) {
  const [apps, setApps] = useState<{ app_id: string; name: string }[] | null>(null)
  useEffect(() => {
    let alive = true
    apiService.getCameraUsedBy(cameraId)
      .then(({ data }) => { if (alive) setApps(data?.apps ?? []) })
      .catch(() => { if (alive) setApps(null) })
    return () => { alive = false }
  }, [cameraId])
  if (apps === null) return null
  return (
    <p className="text-xs text-[var(--muted)]">
      Used by:{' '}
      {apps.length === 0
        ? 'no app yet'
        : apps.map((a) => a.name).join(', ')}
    </p>
  )
}
