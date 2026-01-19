import { useState, useEffect } from 'react'
import { Calendar, dateFnsLocalizer } from 'react-big-calendar'
import format from 'date-fns/format'
import parse from 'date-fns/parse'
import startOfWeek from 'date-fns/startOfWeek'
import getDay from 'date-fns/getDay'
import enUS from 'date-fns/locale/en-US'

import 'react-big-calendar/lib/css/react-big-calendar.css'
import 'react-big-calendar/lib/addons/dragAndDrop/styles.css'

import withDragAndDrop from 'react-big-calendar/lib/addons/dragAndDrop'
import { supabase } from './supabaseClient'

const DnDCalendar = withDragAndDrop(Calendar)

// date handling setup
const locales = { 'en-US': enUS }

const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek,
  getDay,
  locales,
})

// map day codes to weekday numbers (0 = Sun, 1 = Mon, ...)
const DAY_MAP = {
  M: 1, // Monday
  T: 2, // Tuesday
  W: 3, // Wednesday
  R: 4, // Thursday (R is common shorthand)
  F: 5, // Friday
}

// helper: get Monday of the current week
function getWeekStart(date = new Date()) {
  const d = new Date(date)
  const day = d.getDay() // 0 (Sun) .. 6 (Sat)
  const diff = (day + 6) % 7 // days since Monday
  d.setDate(d.getDate() - diff)
  d.setHours(0, 0, 0, 0)
  return d
}

// convert a Date to "HH:MM:SS"
function toTimeString(date) {
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

// turn rows from section_calendar_view into calendar events
function rowsToEvents(rows) {
  const monday = getWeekStart(new Date())
  const events = []

  rows.forEach((row) => {
    // day_code is like "MWF" or "TR"
    const codes = row.day_code ? row.day_code.split('') : ['M']

    codes.forEach((code) => {
      const weekday = DAY_MAP[code]
      if (weekday == null) return

      // clone Monday and move to correct weekday
      const baseDate = new Date(monday)
      baseDate.setDate(monday.getDate() + (weekday - 1))

      // Supabase returns time as "HH:MM:SS"
      const [sh, sm, ss] = row.start_time.split(':').map(Number)
      const [eh, em, es] = row.end_time.split(':').map(Number)

      const start = new Date(baseDate)
      start.setHours(sh, sm, ss || 0, 0)

      const end = new Date(baseDate)
      end.setHours(eh, em, es || 0, 0)

      events.push({
        id: `${row.section_id}-${code}`, // unique per section+day
        sectionId: row.section_id,
        patternSlotId: row.pattern_slot_id,
        timeSlotId: row.time_slot_id,
        title: row.course_code,                  // e.g. CS101
        professor: row.instructor_name,          // e.g. Alice Smith
        room: row.room_name,                     // e.g. Room 101
        gradeLevel: String(row.grade_level),     // "1", "2", ...
        start,
        end,
      })
    })
  })

  return events
}

// helper: check if two time ranges overlap
function timesOverlap(startA, endA, startB, endB) {
  return startA < endB && endA > startB
}

export default function ScheduleCalendar() {
  const [events, setEvents] = useState([])

  // calendar view state
  const [view, setView] = useState('week')
  const [currentDate, setCurrentDate] = useState(new Date())

  // FILTER STATE
  const [professorFilter, setProfessorFilter] = useState('all')
  const [roomFilter, setRoomFilter] = useState('all')
  const [gradeFilter, setGradeFilter] = useState('all')

  // load events from Supabase on first render
  useEffect(() => {
    const fetchEvents = async () => {
      const { data, error } = await supabase
        .from('section_calendar_view')
        .select('*')

      if (error) {
        console.error('Error fetching events from Supabase:', error)
        return
      }

      const mapped = rowsToEvents(data || [])
      setEvents(mapped)
    }

    fetchEvents()
  }, [])

  // unique values for dropdowns
  const professors = Array.from(new Set(events.map((e) => e.professor)))
  const rooms = Array.from(new Set(events.map((e) => e.room)))
  const grades = Array.from(new Set(events.map((e) => e.gradeLevel)))

  // apply ALL filters before passing events to calendar
  const filteredEvents = events.filter((e) => {
    if (professorFilter !== 'all' && e.professor !== professorFilter) return false
    if (roomFilter !== 'all' && e.room !== roomFilter) return false
    if (gradeFilter !== 'all' && e.gradeLevel !== gradeFilter) return false
    return true
  })

  // drag-and-drop handler with conflict checking + DB update
  const handleEventDrop = async ({ event, start, end, isAllDay }) => {
    // For now, don't allow changing the day of week – only the time
    const originalDay = event.start.getDay()
    const newDay = start.getDay()
    if (originalDay !== newDay) {
      alert('For now you can only change the time, not the day of the week.')
      return
    }

    const movedEvent = { ...event, start, end, allDay: isAllDay }

    const conflicts = []

    // conflict checking against ALL events (not just filtered)
    events.forEach((other) => {
      if (other.id === movedEvent.id) return // skip itself

      const overlap = timesOverlap(
        movedEvent.start,
        movedEvent.end,
        other.start,
        other.end
      )

      if (!overlap) return

      // same professor at overlapping time
      if (movedEvent.professor === other.professor) {
        conflicts.push(
          `Professor conflict: ${movedEvent.professor} also has "${other.title}" at this time.`
        )
      }

      // same room at overlapping time
      if (movedEvent.room === other.room) {
        conflicts.push(
          `Room conflict: ${movedEvent.room} is already used by "${other.title}" at this time.`
        )
      }

      // same grade level at overlapping time
      if (movedEvent.gradeLevel === other.gradeLevel) {
        conflicts.push(
          `Grade-level conflict: ${movedEvent.gradeLevel} already has "${other.title}" at this time.`
        )
      }
    })

    if (conflicts.length > 0) {
      alert(conflicts.join('\n'))
      return
    }

    // No conflicts -> update DB (time_slot) then update UI
    const newStartStr = toTimeString(start)
    const newEndStr = toTimeString(end)

    const { error } = await supabase
      .from('time_slot')
      .update({
        start_time: newStartStr,
        end_time: newEndStr,
      })
      .eq('time_slot_id', event.timeSlotId)

    if (error) {
      console.error('Error updating time in Supabase:', error)
      alert('There was a problem saving this change. The calendar was not updated.')
      return
    }

    // Get the new time-of-day from the dropped event
    const sh = start.getHours()
    const sm = start.getMinutes()
    const ss = start.getSeconds()
    const eh = end.getHours()
    const em = end.getMinutes()
    const es = end.getSeconds()

    // Update ALL events that share this timeSlotId (e.g. M/W/F sections)
    setEvents((prev) =>
      prev.map((e) => {
        if (e.timeSlotId !== event.timeSlotId) return e

        const newStart = new Date(e.start)
        newStart.setHours(sh, sm, ss || 0, 0)

        const newEnd = new Date(e.end)
        newEnd.setHours(eh, em, es || 0, 0)

        return { ...e, start: newStart, end: newEnd }
      })
    )
  }

  return (
    <div style={{ height: '80vh', marginTop: '2rem', width: '100%' }}>
      {/* Filter controls */}
      <div
        style={{
          marginBottom: '1rem',
          display: 'flex',
          gap: '1rem',
          flexWrap: 'wrap',
        }}
      >
        {/* Professor filter */}
        <div>
          <label style={{ marginRight: '0.5rem' }}>Professor:</label>
          <select
            value={professorFilter}
            onChange={(e) => setProfessorFilter(e.target.value)}
          >
            <option value="all">All</option>
            {professors.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>

        {/* Room filter */}
        <div>
          <label style={{ marginRight: '0.5rem' }}>Room:</label>
          <select
            value={roomFilter}
            onChange={(e) => setRoomFilter(e.target.value)}
          >
            <option value="all">All</option>
            {rooms.map((room) => (
              <option key={room} value={room}>
                {room}
              </option>
            ))}
          </select>
        </div>

        {/* Grade Level filter */}
        <div>
          <label style={{ marginRight: '0.5rem' }}>Grade level:</label>
          <select
            value={gradeFilter}
            onChange={(e) => setGradeFilter(e.target.value)}
          >
            <option value="all">All</option>
            {grades.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Calendar */}
      <DnDCalendar
        localizer={localizer}
        events={filteredEvents}
        startAccessor="start"
        endAccessor="end"
        view={view}
        onView={setView}
        date={currentDate}
        onNavigate={setCurrentDate}
        views={['month', 'week', 'day', 'agenda']}
        defaultView="week"
        defaultDate={new Date()}
        onEventDrop={handleEventDrop}
        selectable
        resizable={false}
        style={{ height: '100%' }}
      />
    </div>
  )
}
