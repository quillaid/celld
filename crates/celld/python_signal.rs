//! Cross-thread interrupt signals for Python interpreters (experimental).
//!
//! CPython's Emscripten port reads `Module.Py_EmscriptenSignalBuffer[0]`
//! periodically while Python runs (`Python/emscripten_signal.c`). A single
//! isolate thread cannot write that buffer while synchronous Python code
//! occupies the thread, so a Durable Object that runs `while True: pass`
//! cannot receive an in-isolate interrupt. This registry lets a thread other
//! than the isolate thread write the buffer. The Python side routes the signal
//! to its target execution and raises KeyboardInterrupt there
//! (`experiments/python-workers/python_host.py`).
//!
//! This is cooperative. Python checks the buffer between bytecodes, and
//! nothing terminates the isolate. Code that never returns to the eval loop,
//! for example a long C call that does not check for signals, is not
//! interrupted. Destructive termination remains a separate host path.
//!
//! Each Durable Object scope registers two SharedArrayBuffers:
//! - interpreter: `Int32Array(2)` with `[signal, target execution]`. This is
//!   the buffer that the interpreter checks, shared by every object in its
//!   isolate.
//! - session: `Int32Array(1)` with the running execution id of this scope's
//!   session, or 0 when the session is idle. JavaScript writes it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Mutex, OnceLock};

const SIGINT: i32 = 2;

/// A shared backing store written from another thread.
///
/// SAFETY: registration accepts only `is_shared()` stores, whose memory V8
/// makes available to several threads. The registry reads only the
/// immutable data pointer and accesses the memory with atomics. The
/// `SharedRef` keeps that memory alive after its isolate exits, and C++
/// `std::shared_ptr` counting makes the release thread-safe.
struct SharedStore(v8::SharedRef<v8::BackingStore>);
unsafe impl Send for SharedStore {}
unsafe impl Sync for SharedStore {}

impl SharedStore {
    fn new(store: v8::SharedRef<v8::BackingStore>, words: usize) -> Result<Self, &'static str> {
        if !store.is_shared() {
            return Err("Python signal buffers must be SharedArrayBuffers");
        }
        if store.byte_length() < words * 4 || store.data().is_none() {
            return Err("Python signal buffer is too small");
        }
        Ok(Self(store))
    }

    fn word(&self, index: usize) -> &AtomicI32 {
        let base = self.0.data().expect("checked at registration").as_ptr() as *const AtomicI32;
        // SAFETY: the length is checked at registration, and V8 aligns
        // SharedArrayBuffer allocations to at least 8 bytes.
        unsafe { &*base.add(index) }
    }
}

struct Registration {
    interpreter: SharedStore,
    session: SharedStore,
}

fn registry() -> &'static Mutex<HashMap<String, Registration>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Registration>>> = OnceLock::new();
    REGISTRY.get_or_init(Default::default)
}

/// Register or replace the buffers of one Durable Object scope. A new
/// object instance or a new interpreter registers again.
pub fn attach(
    scope: String,
    interpreter: v8::SharedRef<v8::BackingStore>,
    session: v8::SharedRef<v8::BackingStore>,
) -> Result<(), &'static str> {
    let registration = Registration {
        interpreter: SharedStore::new(interpreter, 2)?,
        session: SharedStore::new(session, 1)?,
    };
    registry()
        .lock()
        .expect("python signal registry poisoned")
        .insert(scope, registration);
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// No interpreter has registered this scope on this node.
    Unknown,
    /// The scope's session runs no execution.
    Idle,
    /// SIGINT was written for this execution.
    Signalled { execution: i32 },
}

/// Request KeyboardInterrupt in the execution that this scope's session runs.
/// The call never waits for the isolate thread.
pub fn interrupt(scope: &str) -> Outcome {
    let registry = registry().lock().expect("python signal registry poisoned");
    let Some(registration) = registry.get(scope) else {
        return Outcome::Unknown;
    };
    let execution = registration.session.word(0).load(Ordering::SeqCst);
    if execution == 0 {
        return Outcome::Idle;
    }
    // Write the target before the signal. Python reads the target inside its
    // SIGINT handler, after CPython consumes the signal word. If the execution
    // finishes first, the handler finds no such execution and drops the
    // signal.
    registration
        .interpreter
        .word(1)
        .store(execution, Ordering::SeqCst);
    registration
        .interpreter
        .word(0)
        .store(SIGINT, Ordering::SeqCst);
    Outcome::Signalled { execution }
}

pub fn outcome_json(outcome: &Outcome) -> String {
    match outcome {
        Outcome::Unknown => r#"{"outcome":"unknown"}"#.to_string(),
        Outcome::Idle => r#"{"outcome":"idle"}"#.to_string(),
        Outcome::Signalled { execution } => {
            format!(r#"{{"outcome":"signalled","execution":{execution}}}"#)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shared(words: usize) -> v8::SharedRef<v8::BackingStore> {
        v8::SharedArrayBuffer::new_backing_store_from_vec(vec![0; words * 4]).make_shared()
    }

    fn read(store: &v8::SharedRef<v8::BackingStore>, index: usize) -> i32 {
        let base = store.data().unwrap().as_ptr() as *const AtomicI32;
        unsafe { (*base.add(index)).load(Ordering::SeqCst) }
    }

    #[test]
    fn signals_only_the_running_execution_of_a_registered_scope() {
        let (interpreter, session) = (shared(2), shared(1));
        attach(
            "PythonSession:a".into(),
            interpreter.clone(),
            session.clone(),
        )
        .unwrap();
        assert_eq!(interrupt("PythonSession:missing"), Outcome::Unknown);
        assert_eq!(interrupt("PythonSession:a"), Outcome::Idle);
        assert_eq!(
            (read(&interpreter, 0), read(&interpreter, 1)),
            (0, 0),
            "idle writes nothing"
        );

        let base = session.data().unwrap().as_ptr() as *const AtomicI32;
        unsafe { (*base).store(7, Ordering::SeqCst) };
        // The write comes from a thread other than the one that registered.
        let outcome = std::thread::spawn(|| interrupt("PythonSession:a"))
            .join()
            .unwrap();
        assert_eq!(outcome, Outcome::Signalled { execution: 7 });
        assert_eq!((read(&interpreter, 0), read(&interpreter, 1)), (SIGINT, 7));
        assert_eq!(
            outcome_json(&outcome),
            r#"{"outcome":"signalled","execution":7}"#
        );
    }

    #[test]
    fn rejects_unshared_and_short_buffers() {
        let unshared = v8::ArrayBuffer::new_backing_store_from_vec(vec![0; 8]).make_shared();
        assert!(attach("PythonSession:b".into(), unshared, shared(1)).is_err());
        assert!(attach("PythonSession:b".into(), shared(1), shared(1)).is_err());
        assert_eq!(interrupt("PythonSession:b"), Outcome::Unknown);
    }
}
