"""A tiny generic registry, used for strategies, prioritizers, stop conditions
and result analyzers (spec §32).

`register(name, obj)` binds a name to an implementation; `create(name, **kw)`
builds one from a registered factory; `all()` enumerates. The core loop depends
only on these registries and the module interfaces, never on a concrete class, so
a new strategy is added by registering it — not by editing the loop.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterator
from typing import Generic, TypeVar

log = logging.getLogger("agent.research.registry")

T = TypeVar("T")


class Registry(Generic[T]):
    """A name → object/factory registry. Insertion order is preserved so
    `all()` is stable and testable."""

    def __init__(self, kind: str = "item"):
        self.kind = kind
        self._items: dict[str, T] = {}
        self._factories: dict[str, Callable[..., T]] = {}

    def register(self, name: str, obj: T) -> T:
        if name in self._items:
            log.debug("overriding registered %s %r", self.kind, name)
        self._items[name] = obj
        return obj

    def register_factory(self, name: str, factory: Callable[..., T]) -> None:
        self._factories[name] = factory

    def has(self, name: str) -> bool:
        return name in self._items or name in self._factories

    def get(self, name: str) -> T:
        if name in self._items:
            return self._items[name]
        raise KeyError(f"no {self.kind} registered as {name!r}")

    def create(self, name: str, **kwargs) -> T:
        if name in self._items:
            return self._items[name]
        if name in self._factories:
            obj = self._factories[name](**kwargs)
            self._items[name] = obj
            return obj
        raise KeyError(f"no {self.kind} registered as {name!r}")

    def names(self) -> list[str]:
        return list(dict.fromkeys([*self._items.keys(), *self._factories.keys()]))

    def all(self) -> list[T]:
        # instantiate any factory not yet built with no args (they must have
        # sensible defaults), so enumeration is complete
        return [self.get(n) for n in self.names()]

    def __contains__(self, name: str) -> bool:
        return self.has(name)

    def __iter__(self) -> Iterator[T]:
        return iter(self.all())

    def __len__(self) -> int:
        return len(self.names())
