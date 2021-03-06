/*
  # SwitchCollection: A custom combinator for streams of collections

  When a new collection is received in a stream of collections, usually it is an
  updated instance of the previously-received collection, seeing as collection
  instances are immutable. Instead of performing a naive switch operation
  against sinks in each collection item, which would cause frequent cases of
  unchanged streams being disposed and re-observed, state is maintained to keep
  active streams alive if their status has not changed from one collection
  instance to the next.

  The combinator is configured during construction to match one or more specific
  sinks that it will monitor within each item in the active collection. Whenever
  a new collection arrives from upstream, it is compared to the current active
  collection (if any). The following operations are performed:

  1. Any matching streams in new collection items will be run and merged into
     active downstream emissions.
  2. Streams from collection items that only exist in the previous collection
     instance are disposed of and removed from the set of active sinks.
  3. Streams for collection items that exist in both the old and new versions of
     the collection are compared for reference equality. If both items reference
     the same stream, it is left as-is so as not to interrupt the active state
     of the stream. If the stream reference is different, the old instance is
     disposed and removed, and the new one is activated to replace the old one.
*/

import most from 'most';
import Collection from './index';
import {calculateDiff} from './diff';

const defaultMissingSink = most.just(null);

export default function switchCollection(keys, list$) {
  if(!list$ || !list$.source) {
    throw new Error('The last argument to `switchCollection` must be a stream of collections');
  }

  if(!Array.isArray(keys) || keys.length === 0) {
    throw new Error('The first argument to `switchCollection` must be an array with at least one key');
  }

  if(keys.some(key => typeof key !== 'string')) {
    throw new Error('Every element in the `keys` argument must be a string');
  }

  return new most.Stream(new SwitchCollectionSource(keys, list$.source));
}

class SwitchCollectionSource
{
  constructor(keys, source) {
    this._sinkKeys = keys;
    this.source = source;
  }

  run(sink, scheduler) {
    const switchSink = new SwitchCollectionSink(this._sinkKeys, sink, scheduler);
    return this.source.run(switchSink, scheduler);
  }
}

class SwitchCollectionSink
{
  constructor(keys, sink, scheduler) {
    this._sinkKeys = keys;
    this._sink = sink;
    this._scheduler = scheduler;
    this._state = new Map();
    this._list = Collection();
    this._active = true;
    this._disposed = false;
    this._activeCount = 0;
    this._ended = false;
    this._endValue = void 0;
  }

  _getSinkState(key) {
    if(!this._state.has(key)) {
      this._state.set(key, new Map());
    }
    return this._state.get(key);
  }

  _getItemState(sinkState, key) {
    if(!sinkState.has(key)) {
      sinkState.set(key, new Map());
    }
    return sinkState.get(key);
  }

  _run(sinkKey, itemKey, stream) {
    this._activeCount++;
    return new InnerSink(sinkKey, itemKey, this, this._scheduler, stream);
  }

  _remove(sinkKey, itemKey) {
    const items = this._state.get(sinkKey);
    if(!items) {
      return;
    }
    const item = items.get(itemKey);
    if(!item) {
      return;
    }
    if(item.active) {
      this._activeCount--;
    }
    item.dispose();
    items.delete(itemKey);
    if(items.size === 0) {
      this._state.delete(sinkKey);
    }
  }

  _add(sinkKey, itemKey) {
    let items = this._state.get(sinkKey);
    if(!items) {
      items = new Map();
      this._state.set(sinkKey, items);
    }
    else if(items.has(itemKey)) {
      return this._check(sinkKey, itemKey);
    }
    const stream = getSink(itemKey, sinkKey, this._list);
    items.set(itemKey, this._run(sinkKey, itemKey, stream));
  }

  _update(sinkKey, itemKey) {
    const items = this._state.get(sinkKey);
    const item = items && items.get(itemKey);
    if(!item) {
      return this._add(sinkKey, itemKey); // shouldn't ever happen
    }
    const newStream = getSink(itemKey, sinkKey, this._list);

    if(item.isDifferentStream(newStream)) {
      if(item.active) {
        this._activeCount--;
      }
      item.dispose();
      items.set(itemKey, this._run(sinkKey, itemKey, newStream));
    }
  }

  _end(t) {
    if(this._ended && this._activeCount === 0) {
      this._active = false;
      this._sink.end(t, this._endValue); // only end when all internal streams have ended
    }
  }

  eventInner(sinkKey, itemKey, t, x) {
    if(!this._active) {
      return;
    }
    this._sink.event(t, [itemKey, sinkKey, x]);
  }

  endInner(t) {
    if(!this._active) {
      return;
    }
    this._activeCount--;
    this._end(t);
  }

  event(t, list) {
    if(!this._active) {
      return;
    }
    const changes = calculateDiff(this._sinkKeys, this._list, list);
    this._list = list;
    if(changes) {
      this._sinkKeys.forEach(sinkKey => {
        changes.removed.forEach((_, itemKey) => {
          this._remove(sinkKey, itemKey);
        });
        changes.added.forEach((_, itemKey) => {
          this._add(sinkKey, itemKey);
        });
        changes.changed.forEach((_, itemKey) => {
          this._update(sinkKey, itemKey);
        });
      });
    }
    this._sink.event(t, {list, changes});
  }

  end(t, x) {
    if(!this._active) {
      return;
    }
    this._endValue = x;
    this._ended = true;
    this._end(t);
  }

  error(t, e) {
    if(!this._active) {
      return;
    }
    this._active = false;
    this._sink.error(t, e);
  }

  _disposeState() {
    this._state.forEach(items => {
      items.forEach(item => item.dispose());
      items.clear();
    });
    this._state.clear();
  }

  dispose() {
    if(this._disposed) {
      return;
    }
    this._disposed = true;
    this._active = false;
    this._disposeState();
  }
}

class InnerSink
{
  constructor(sinkKey, itemKey, sink, scheduler, stream) {
    this._sinkKey = sinkKey;
    this._itemKey = itemKey;
    this._sink = sink;
    this._scheduler = scheduler;
    this._disposed = false;
    this._active = true;
    this._activate(stream);
  }

  _activate(stream) {
    this._stream = stream;
    this._disposable = this._stream.source.run(this, this._scheduler);
    this._disposed = false;
  }

  get active() {
    return this._active;
  }

  isDifferentStream(stream) {
    return this._stream !== stream;
  }

  event(t, x) {
    if(this._disposed) {
      return;
    }
    this._sink.eventInner(this._sinkKey, this._itemKey, t, x);
  }

  end(t, x) {
    if(this._disposed) {
      return;
    }
    this._active = false;
    this._sink.endInner(t);
    this.dispose();
  }

  error(t, e) {
    if(this._disposed) {
      return;
    }
    this._active = false;
    this._sink.error(t, e);
    this.dispose();
  }

  dispose() {
    if(this._disposed) {
      return;
    }
    this._disposable.dispose();
    this._disposed = true;
    this._active = false;
  }
}

function getSink(itemKey, sinkKey, list) {
  const item = list.get(itemKey);
  return item && item.sinks[sinkKey] || defaultMissingSink; // otherwise the sink will prevent snapshotting
}

