use super::*;

#[test]
fn invalidated_heap_restarts_its_objects_at_the_same_epoch() {
    for announced_generation in [0, 7] {
        let mut state = State::new(
            "node",
            Config {
                require_node_lease: false,
                max_resident: 16,
                max_activations: 4,
                max_evictions: 4,
                max_releases: 4,
                max_outbound_websockets: 4,
                ownership_on_evict: OwnershipOnEvict::Sticky,
                peer_protocol: 1,
                operation_deadline_ms: None,
                owner_log_recovery_backoff_ms: 1000,
                owner_log_recovery_attempts: 3,
                alarm_resident_ms: 1000,
                idle_evict_ms: None,
                pressure: pressure::PressureConfig::from_limits(None, Some(0)),
            },
        );
        state.current_generation = announced_generation;
        let broken = isolate::HeapId::new(11);
        let healthy = isolate::HeapId::new(12);
        for (id, heap) in [
            ("Counter:a", broken),
            ("Counter:b", broken),
            ("Counter:c", healthy),
        ] {
            let mut cell = Cell {
                isolate: Some(heap),
                generation: 7,
                ..Cell::default()
            };
            set_phase(
                &mut state.occupied,
                &mut cell,
                Phase::Resident { epoch: 42 },
            );
            state.cells.insert(id.into(), cell);
        }
        let effects = on_event(&mut state, Event::RuntimeInvalidated { isolate: broken });
        let stops: Vec<_> = effects
            .iter()
            .filter_map(|effect| match effect {
                Effect::StopRuntime {
                    op,
                    cell,
                    epoch,
                    cause: StopCause::Swap,
                    ..
                } => {
                    assert_eq!(*epoch, 42);
                    Some((*op, cell.clone()))
                }
                _ => None,
            })
            .collect();
        assert_eq!(stops.len(), 2, "{effects:?}");
        assert!(stops.iter().all(|(_, cell)| cell != "Counter:c"));
        assert!(matches!(
            state.cells["Counter:c"].phase,
            Phase::Resident { epoch: 42 }
        ));
        for (op, id) in stops {
            let effects = on_event(&mut state, Event::RuntimeStopped { op });
            assert!(
                effects.iter().any(|effect| matches!(effect,
                    Effect::StartRuntime { cell, epoch: 42, .. } if cell == &id
                )),
                "{effects:?}"
            );
        }
    }
}
