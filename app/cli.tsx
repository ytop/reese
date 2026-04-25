#!/usr/bin/env bun
import React from 'react';
import { render, Text, Box } from 'ink';
import * as backend from './backend.ts';

const args = process.argv.slice(2);
const [cmd, ...params] = args;

const App = () => {
  if (cmd === 'add') {
    const [title, date, ...desc] = params;
    if (!title || !date) return <Text color="red">Usage: add &lt;title&gt; &lt;date&gt; [description]</Text>;
    try {
      const event = backend.create(title, date, desc.join(' '));
      return <Text color="green">Created event with ID: {event.id}</Text>;
    } catch (e: any) {
      return <Text color="red">Error: {e.message}</Text>;
    }
  }

  if (cmd === 'list') {
    let events: backend.Event[];
    if (params.length >= 2) {
      const [start, end] = params;
      events = backend.readRange(start, end);
    } else {
      events = backend.read() as backend.Event[];
    }

    if (!events.length) return <Text italic>No events found.</Text>;
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text bold underline>Calendar Events</Text>
        {events.map(e => (
          <Text key={e.id}>
            <Text color="cyan">{e.id.padEnd(4)}</Text> | <Text color="yellow">{e.date}</Text> | {e.title}
          </Text>
        ))}
      </Box>
    );
  }

  if (cmd === 'get') {
    const id = params[0];
    if (!id) return <Text color="red">Usage: get &lt;id&gt;</Text>;
    const event = backend.read(id) as backend.Event;
    if (!event) return <Text color="red">Event not found.</Text>;
    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text><Text bold>ID:</Text> {event.id}</Text>
        <Text><Text bold>Title:</Text> {event.title}</Text>
        <Text><Text bold>Date:</Text> {event.date}</Text>
        {event.description && <Text><Text bold>Description:</Text> {event.description}</Text>}
      </Box>
    );
  }

  if (cmd === 'update') {
    const [id, field, ...value] = params;
    if (!id || !field || value.length === 0) {
      return <Text color="red">Usage: update &lt;id&gt; &lt;field&gt; &lt;value&gt;</Text>;
    }
    const event = backend.update(id, { [field]: value.join(' ') });
    if (!event) return <Text color="red">Event not found.</Text>;
    return <Text color="green">Successfully updated event {id}.</Text>;
  }

  if (cmd === 'delete') {
    const id = params[0];
    if (!id) return <Text color="red">Usage: delete &lt;id&gt;</Text>;
    const ok = backend.remove(id);
    return <Text color={ok ? 'green' : 'red'}>{ok ? `Deleted event ${id}.` : 'Event not found.'}</Text>;
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="magenta">Calendar CLI Helper</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text>add &lt;title&gt; &lt;date&gt; [description] - Create a new event</Text>
        <Text>list [start_date] [end_date]        - List all events or within range</Text>
        <Text>get &lt;id&gt;                           - Show event details</Text>
        <Text>update &lt;id&gt; &lt;field&gt; &lt;value&gt;       - Update an event field</Text>
        <Text>delete &lt;id&gt;                        - Remove an event</Text>
      </Box>
    </Box>
  );
};

render(<App />);
