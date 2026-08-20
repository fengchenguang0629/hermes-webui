"""Fork-local feature: workspace preview selection → "Add selection to chat".

Covers the wiring for right-clicking selected text inside the workspace file
preview (code / markdown / csv surfaces) and adding it as a named context
block that is injected into the next outgoing message.

Design contract under test (see static/workspace_selection_to_chat.js header):
  - Self-contained file loaded via one <script> line in index.html; the feature
    must not be wired from workspace.js or messages.js (fork merge hygiene).
  - i18n.js must stay untouched: all copy lives in a built-in en/zh/zh-Hant
    dictionary inside the feature file (i18n.js is the most conflict-prone
    file in the repo; upstream locale-coverage tests also require every en
    key to exist in all 16 locale blocks, which a fork-local key would fail).
  - Injection reuses the existing selected-text-reply pipeline entry point
    ``_addNamedContextBlock`` — the feature must NOT reimplement the
    ``_pendingSelections`` / composer-flush mechanism.
  - Degrades safely: every cross-file dependency is typeof-guarded.
  - Scoped ONLY to the text-bearing preview surfaces; the chat area already
    has its own selection toolbar (#2481) and must stay untouched.
"""
from pathlib import Path
import re

REPO = Path(__file__).resolve().parent.parent
JS = (REPO / "static" / "workspace_selection_to_chat.js").read_text(encoding="utf-8")
INDEX = (REPO / "static" / "index.html").read_text(encoding="utf-8")
MESSAGES = (REPO / "static" / "messages.js").read_text(encoding="utf-8")


def test_script_is_loaded_by_index_html_with_version_token():
    assert re.search(
        r'<script src="static/workspace_selection_to_chat\.js\?v=__WEBUI_VERSION__" defer></script>',
        INDEX,
    ), "index.html must load the fork-local script with the standard cache-bust token"


def test_script_loads_after_messages_js():
    """The script calls _addNamedContextBlock, so its tag must come after
    messages.js (classic shared-globals scripts resolve cross-file names at
    call time, but loading after the definition keeps call-time binding safe)."""
    idx_messages = INDEX.index('src="static/messages.js?v=__WEBUI_VERSION__"')
    idx_feature = INDEX.index('src="static/workspace_selection_to_chat.js?v=__WEBUI_VERSION__"')
    assert idx_feature > idx_messages


def test_feature_reuses_upstream_pipeline_without_reimplementing_it():
    assert "_addNamedContextBlock(text)" in JS
    # The feature must not rebuild the context-block machinery itself.
    assert "_pendingSelections" not in JS
    assert "_flushSelectionBlocksToComposer" not in JS
    assert "_composerTextWithPendingSelections" not in JS


def test_pipeline_entry_point_still_exists_upstream():
    """Guard the upstream contract this feature depends on (brick-class if an
    upstream merge renames the entry point — the feature then no-ops with a
    toast, which is the designed degradation, but this test should force us
    to notice and re-point the call)."""
    assert "function _addNamedContextBlock(text)" in MESSAGES


def test_scope_is_limited_to_text_preview_surfaces():
    assert "['previewCode','previewMd','previewEditArea']" in JS
    # The chat selection toolbar (#2481) owns the messages area — the feature
    # must not widen its scope there.
    assert "$('messages')" not in JS
    assert "msgInner" not in JS


def test_context_menu_item_and_dismiss_wiring():
    assert "document.addEventListener('contextmenu'" in JS
    assert "wsSel2ChatMenu" in JS
    # Outside-click dismiss must use capture phase to win races with other menus.
    assert "document.addEventListener('click',_wsSel2ChatDismissMenu,true)" in JS
    # Selection snapshot fallback: right-button mousedown can collapse the
    # selection before contextmenu fires on some platforms.
    assert "mouseup" in JS
    assert "_wsSel2ChatSnapshot" in JS


def test_dependencies_are_typeof_guarded():
    """A missing upstream symbol must degrade to a toast, never a ReferenceError."""
    for guarded in ("typeof _addNamedContextBlock!=='function'", "typeof showToast==='function'"):
        assert guarded in JS, f"missing typeof guard: {guarded}"


def test_i18n_is_selfcontained_and_i18n_js_stays_untouched():
    """All user-facing copy lives in the feature file's built-in dictionary;
    the feature must add NO keys to static/i18n.js."""
    assert "_WS_SEL2CHAT_STRINGS" in JS
    for lang in ("en:", "zh:", "'zh-Hant':"):
        assert lang in JS, f"built-in dictionary missing locale {lang!r}"
    # Locale detection: prefer the active i18n.js locale tag, fall back to
    # <html lang>, normalized the way i18n.js normalizes (zh-TW → zh-Hant …).
    assert "locale._lang" in JS
    assert "document.documentElement.lang" in JS
    # And the repo's i18n.js itself must not reference the feature's keys.
    i18n = (REPO / "static" / "i18n.js").read_text(encoding="utf-8")
    assert "workspace_selection_to_chat" not in i18n


def test_chinese_dictionary_entries_present():
    """zh + zh-Hant are the locales this fork actually ships for."""
    assert "添加所选内容到对话" in JS
    assert "新增所選內容到對話" in JS


def test_no_native_confirm_or_prompt():
    assert not re.search(r"\bconfirm\s*\(", JS)
    assert not re.search(r"\bprompt\s*\(", JS)


def test_feature_script_has_no_conflict_markers():
    for marker in ("<<<<<<<", ">>>>>>>"):
        assert marker not in JS, "conflict marker left in workspace_selection_to_chat.js"
