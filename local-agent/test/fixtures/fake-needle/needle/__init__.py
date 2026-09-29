"""A stand-in for cactus-needle with the same surface the bridge uses.

It lets the bridge, the Node client and the rescue logic be tested end to end
without the real engine or its weights. Its answers are rules, not a model, so
a pass here proves the plumbing, the gating and the grounding checks - not
how well Needle reads a plan. Markers in the input text drive the edge cases:

    WITHHOLD   the record comes back in suppressed_calls
    LOWCONF    confidence 0.2
    GHOST      the model names a file that is not in the text
    INVENTED   the run command is not in the text
    HANG       complete() never returns
    CRASH      the process exits
"""
import os
import re
import sys
import time

__version__ = "fake-0"

_PATH = re.compile(r"[\w./-]+\.(?:py|js|ts|json|html|css|md|txt|toml|sql)\b")


def _first_sentence(text):
    text = re.sub(r"\s+", " ", text).strip()
    m = re.match(r"(.+?[.!?])(\s|$)", text)
    return (m.group(1) if m else text)[:160]


class Needle:
    def __init__(self, tools=None, system=None, weights=None, tool_index_path=None,
                 buffer_size=65536, auto_date=True, generation=None, stateless=False):
        self.tool = (tools or [{}])[0]
        self.weights = weights

    def complete(self, text="", max_new_tokens=512):
        if "HANG" in text:
            time.sleep(3600)
        if "CRASH" in text:
            os._exit(3)
        name = self.tool.get("name")
        args = {}
        if name == "plan_step":
            head = text.strip().splitlines()[0] if text.strip() else ""
            title = re.sub(r"^\W*step\s+\d+\W*", "", head, flags=re.I).strip(" *#:")
            files = _PATH.findall(text)
            if "GHOST" in text:
                files.append("ghost/invented.py")
            args = {"title": title, "files": files, "testable": "test" in text.lower()}
        elif name == "project_plan":
            args = {"summary": _first_sentence(text)}
            m = re.search(r"[Rr]un (?:it )?with:?\s*`?([^`\n]+)`?", text)
            if m:
                args["run_command"] = m.group(1).strip()
            if "INVENTED" in text:
                args["run_command"] = "python3 made_up.py"
        elif name == "reply_kind":
            low = text.lower()
            sentences = re.split(r"(?<=[.!?])\s+", text.strip())
            if "can't help" in low or "cannot help" in low or "won't" in low:
                args = {"kind": "refusal", "quote": next(s for s in sentences if "help" in s.lower() or "won't" in s.lower())}
            elif text.strip().endswith("?"):
                args = {"kind": "question", "quote": sentences[-1]}
            elif "step 1" in low:
                args = {"kind": "plan"}
            else:
                args = {"kind": "other", "quote": "words the reply never said"}
        call = {"name": name, "arguments": args}
        confidence = 0.2 if "LOWCONF" in text else 0.9
        if "WITHHOLD" in text:
            return {"type": "call", "function_calls": [], "suppressed_calls": [call],
                    "confidence": 0.05, "reasoning": "withheld"}
        return {"type": "call", "function_calls": [call] if name != "ping" else [],
                "confidence": confidence, "reasoning": "fake"}

    def close(self):
        pass
