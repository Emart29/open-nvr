// Copyright (c) 2026 OpenNVR
// SPDX-License-Identifier: AGPL-3.0-or-later

import { api } from '../lib/api'
import type { TourStep } from '../lib/tourPlan'

/** A tour as the server returns it: every step already filtered to the viewer. */
export interface Tour {
  id: number
  name: string
  description?: string | null
  enabled: boolean
  revision: number
  /** False when it holds cameras this user cannot see: they may run it, not change it. */
  editable: boolean
  steps: TourStep[]
  created_at?: string | null
  updated_at?: string | null
}

export interface TourInput {
  name: string
  description?: string | null
  enabled: boolean
  steps: Array<{ label: string; layout_id: string; duration_s: number; camera_ids: number[] }>
  expected_revision?: number
}

export const tourService = {
  getTours: () => api.get('/api/v1/tours'),
  getTour: (tourId: number) => api.get(`/api/v1/tours/${tourId}`),
  createTour: (body: TourInput) => api.post('/api/v1/tours', body),
  updateTour: (tourId: number, body: TourInput) => api.put(`/api/v1/tours/${tourId}`, body),
  deleteTour: (tourId: number) => api.delete(`/api/v1/tours/${tourId}`),
  // Stream info that also carries the low-res substream URL (webrtc_sub);
  // the plain getStreamInfo call is left exactly as it was.
  getTourStreamInfo: (cameraId: number) =>
    api.get(`/api/v1/streams/${cameraId}/info`, { params: { include_sub: true } }),
}
