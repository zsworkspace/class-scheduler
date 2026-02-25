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
  M: 1,
  T: 2,
  W: 3,
  R: 4,
  F: 5,
}

// helper: get Monday of the current week
function getWeekStart(date = new Date()) {
  const d = new Date(date)
  const day = d.getDay()
  const diff = (day + 6) % 7
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
    const codes = row.day_code ? row.day_code.split('') : ['M']

    codes.forEach((code) => {
      const weekday = DAY_MAP[code]
      if (weekday == null) return

      const baseDate = new Date(monday)
      baseDate.setDate(monday.getDate() + (weekday - 1))

      const [sh, sm, ss] = row.start_time.split(':').map(Number)
      const [eh, em, es] = row.end_time.split(':').map(Number)

      const start = new Date(baseDate)
      start.setHours(sh, sm, ss || 0, 0)

      const end = new Date(baseDate)
      end.setHours(eh, em, es || 0, 0)

      events.push({
        id: `${row.section_id}-${code}`,
        sectionId: row.section_id,
        patternSlotId: row.pattern_slot_id,
        timeSlotId: row.time_slot_id,
        title: row.course_code,
        professor: row.instructor_name,
        room: row.room_name,
        gradeLevel: String(row.grade_level),
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

  const [view, setView] = useState('week')
  const [currentDate, setCurrentDate] = useState(new Date())

  // FILTER STATE (arrays of selected values; empty array = show all)
  const [professorFilter, setProfessorFilter] = useState([])
  const [roomFilter, setRoomFilter] = useState([])
  const [gradeFilter, setGradeFilter] = useState([])

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

  const professors = Array.from(new Set(events.map((e) => e.professor))).sort()
  const rooms = Array.from(new Set(events.map((e) => e.room))).sort()
  const grades = Array.from(new Set(events.map((e) => e.gradeLevel))).sort()

  const toggleFilterValue = (value, currentArray, setFn) => {
    if (value === '__ALL__') {
      setFn([])
      return
    }

    setFn((prev) => {
      if (prev.length === 0) {
        return [value]
      }
      if (prev.includes(value)) {
        const next = prev.filter((v) => v !== value)
        return next
      }
      return [...prev, value]
    })
  }

  const filteredEvents = events.filter((e) => {
    if (professorFilter.length > 0 && !professorFilter.includes(e.professor)) {
      return false
    }
    if (roomFilter.length > 0 && !roomFilter.includes(e.room)) {
      return false
    }
    if (gradeFilter.length > 0 && !gradeFilter.includes(e.gradeLevel)) {
      return false
    }
    return true
  })

  const handleEventDrop = async ({ event, start, end, isAllDay }) => {
    const originalDay = event.start.getDay()
    const newDay = start.getDay()
    if (originalDay !== newDay) {
      alert('For now you can only change the time, not the day of the week.')
      return
    }

    const movedEvent = { ...event, start, end, allDay: isAllDay }

    const conflicts = []

    events.forEach((other) => {
      if (other.id === movedEvent.id) return

      const overlap = timesOverlap(
        movedEvent.start,
        movedEvent.end,
        other.start,
        other.end
      )

      if (!overlap) return

      if (movedEvent.professor === other.professor) {
        conflicts.push(
          `Professor conflict: ${movedEvent.professor} also has "${other.title}" at this time.`
        )
      }

      if (movedEvent.room === other.room) {
        conflicts.push(
          `Room conflict: ${movedEvent.room} is already used by "${other.title}" at this time.`
        )
      }

      if (movedEvent.gradeLevel === other.gradeLevel) {
        conflicts.push(
          `Grade-level conflict: ${movedEvent.gradeLevel} already has "${other.title}" at this time.`
        )
      }
    })

    if (conflicts.length > 0) {
      const message =
        conflicts.join('\n') +
        '\n\nClick "OK" to override and move the class anyway, or "Cancel" to keep the original time.'
      const override = window.confirm(message)
      if (!override) {
        return
      }
    }

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
      alert(
        'There was a problem saving this change in the database, so the calendar was not updated.'
      )
      return
    }

    const sh = start.getHours()
    const sm = start.getMinutes()
    const ss = start.getSeconds()
    const eh = end.getHours()
    const em = end.getMinutes()
    const es = end.getSeconds()

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
    <div style={{ height: '80vh', marginTop: '1rem', width: '100%' }}>
      {/* Filter controls - dropdown style using <details> */}
      <div
        style={{
          marginBottom: '0.75rem',
          display: 'flex',
          gap: '2rem',
          flexWrap: 'wrap',
        }}
      >
        {/* Professor filter */}
        <div>
          <details>
            <summary
              style={{
                fontWeight: 'bold',
                cursor: 'pointer',
                listStyle: 'none',
              }}
            >
              Professor
            </summary>
            <div style={{ marginTop: '0.25rem' }}>
              <div>
                <label>
                  <input
                    type="checkbox"
                    checked={professorFilter.length === 0}
                    onChange={() =>
                      toggleFilterValue(
                        '__ALL__',
                        professorFilter,
                        setProfessorFilter
                      )
                    }
                  />{' '}
                  All
                </label>
              </div>
              {professors.map((name) => (
                <div key={name}>
                  <label>
                    <input
                      type="checkbox"
                      checked={professorFilter.includes(name)}
                      onChange={() =>
                        toggleFilterValue(
                          name,
                          professorFilter,
                          setProfessorFilter
                        )
                      }
                    />{' '}
                    {name}
                  </label>
                </div>
              ))}
            </div>
          </details>
        </div>

        {/* Room filter */}
        <div>
          <details>
            <summary
              style={{
                fontWeight: 'bold',
                cursor: 'pointer',
                listStyle: 'none',
              }}
            >
              Room
            </summary>
            <div style={{ marginTop: '0.25rem' }}>
              <div>
                <label>
                  <input
                    type="checkbox"
                    checked={roomFilter.length === 0}
                    onChange={() =>
                      toggleFilterValue('__ALL__', roomFilter, setRoomFilter)
                    }
                  />{' '}
                  All
                </label>
              </div>
              {rooms.map((room) => (
                <div key={room}>
                  <label>
                    <input
                      type="checkbox"
                      checked={roomFilter.includes(room)}
                      onChange={() =>
                        toggleFilterValue(room, roomFilter, setRoomFilter)
                      }
                    />{' '}
                    {room}
                  </label>
                </div>
              ))}
            </div>
          </details>
        </div>

        {/* Grade Level filter */}
        <div>
          <details>
            <summary
              style={{
                fontWeight: 'bold',
                cursor: 'pointer',
                listStyle: 'none',
              }}
            >
              Grade level
            </summary>
            <div style={{ marginTop: '0.25rem' }}>
              <div>
                <label>
                  <input
                    type="checkbox"
                    checked={gradeFilter.length === 0}
                    onChange={() =>
                      toggleFilterValue('__ALL__', gradeFilter, setGradeFilter)
                    }
                  />{' '}
                  All
                </label>
              </div>
              {grades.map((level) => (
                <div key={level}>
                  <label>
                    <input
                      type="checkbox"
                      checked={gradeFilter.includes(level)}
                      onChange={() =>
                        toggleFilterValue(level, gradeFilter, setGradeFilter)
                      }
                    />{' '}
                    {level}
                  </label>
                </div>
              ))}
            </div>
          </details>
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
