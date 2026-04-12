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
    const event = backend.create(title, date, desc.join(' '));
    return <Text color="green">Created: {event.id}</Text>;
  }

  if (cmd === 'list') {
    const events = backend.read() as backend.Event[];
    if (!events.length) return <Text>No events</Text>;
    return (
      <Box flexDirection="column">
        {events.map(e => (
          <Text key={e.id}>{e.id} | {e.date} | {e.title}</Text>
        ))}
      </Box>
    );
  }

  if (cmd === 'get') {
    const event = backend.read(params[0]) as backend.Event;
    if (!event) return <Text color="red">Not found</Text>;
    return (
      <Box flexDirection="column">
        <Text>ID: {event.id}</Text>
        <Text>Title: {event.title}</Text>
        <Text>Date: {event.date}</Text>
        {event.description && <Text>Description: {event.description}</Text>}
      </Box>
    );
  }

  if (cmd === 'update') {
    const [id, field, ...value] = params;
    if (!id || !field) return <Text color="red">Usage: update &lt;id&gt; &lt;field&gt; &lt;value&gt;</Text>;
    const event = backend.update(id, { [field]: value.join(' ') });
    if (!event) return <Text color="red">Not found</Text>;
    return <Text color="green">Updated</Text>;
  }

  if (cmd === 'delete') {
    const ok = backend.remove(params[0]);
    return <Text color={ok ? 'green' : 'red'}>{ok ? 'Deleted' : 'Not found'}</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text bold>Calendar CLI</Text>
      <Text>add &lt;title&gt; &lt;date&gt; [description]</Text>
      <Text>list</Text>
      <Text>get &lt;id&gt;</Text>
      <Text>update &lt;id&gt; &lt;field&gt; &lt;value&gt;</Text>
      <Text>delete &lt;id&gt;</Text>
    </Box>
  );
};

render(<App />);
