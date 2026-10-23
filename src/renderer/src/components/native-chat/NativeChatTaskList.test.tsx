// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeChatTaskList } from './NativeChatTaskList'
import type { NativeChatTaskList as TaskList } from '../../../../shared/native-chat-task-list'

afterEach(cleanup)
const previous: TaskList = {
  tasks: [
    { content: 'Read', status: 'in_progress', activeForm: 'Reading' },
    { content: 'Write', status: 'pending', activeForm: 'Writing' },
    { content: 'Test', status: 'pending' }
  ]
}
const current: TaskList = {
  tasks: [
    { content: 'Read', status: 'completed', activeForm: 'Reading' },
    { content: 'Write', status: 'in_progress', activeForm: 'Writing' },
    { content: 'Test', status: 'pending' }
  ]
}

describe('NativeChatTaskList', () => {
  it('marks task priority with a colored dot', () => {
    const withPriority: TaskList = {
      tasks: [
        { content: 'Urgent', status: 'pending', priority: 'high' },
        { content: 'Later', status: 'pending', priority: 'low' },
        { content: 'Plain', status: 'pending' }
      ]
    }
    const { container } = render(<NativeChatTaskList list={withPriority} />)
    const dots = container.querySelectorAll('span.rounded-full')
    expect(dots).toHaveLength(2)
    expect(dots[0]).toHaveAttribute('aria-label', 'high')
    expect(dots[0]).toHaveClass('bg-red-500')
    expect(dots[1]).toHaveAttribute('aria-label', 'low')
  })

  it('shows tri-state glyphs, progress, and activeForm in the first checklist', () => {
    const { container } = render(<NativeChatTaskList list={current} />)
    expect(screen.getByText('Read')).toHaveClass('line-through')
    expect(screen.getByText('Writing').closest('li')).toHaveClass('text-chat-foreground-strong')
    expect(screen.getByText('Test')).toBeInTheDocument()
    expect(screen.getByLabelText('1 of 3 tasks completed')).toHaveTextContent('1/3')
    for (const glyph of ['circle', 'circle-dot', 'circle-check']) {
      expect(container.querySelector(`.lucide-${glyph}`)).not.toBeNull()
    }
    expect(screen.getByText('In progress:')).toHaveClass('sr-only')
  })

  it('leads with the diff and expands the complete checklist on demand', () => {
    render(<NativeChatTaskList list={current} previous={previous} />)
    expect(screen.getByText('Completed Read')).toBeInTheDocument()
    expect(screen.getByText('Started Write')).toBeInTheDocument()
    expect(screen.queryByText('Test')).toBeNull()
    const disclosure = screen.getByRole('button', { name: 'Full task list' })
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(disclosure)
    expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Writing')).toBeInTheDocument()
    expect(screen.getByText('Test')).toBeInTheDocument()
  })

  it('shows unchanged feedback and the current explanation', () => {
    render(
      <NativeChatTaskList
        list={{ ...current, explanation: 'Continuing verification' }}
        previous={current}
      />
    )
    expect(screen.getByText('Tasks unchanged')).toBeInTheDocument()
    expect(screen.getByText('Continuing verification')).toBeInTheDocument()
    expect(screen.queryByText('Test')).toBeNull()
  })

  it('renders empty lists without claiming any task completed', () => {
    render(<NativeChatTaskList list={{ tasks: [] }} />)
    expect(screen.getByText('No tasks')).toBeInTheDocument()
    expect(screen.getByLabelText('0 of 0 tasks completed')).toHaveTextContent('0/0')
  })
})
