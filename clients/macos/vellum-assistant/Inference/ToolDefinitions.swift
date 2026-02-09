import Foundation

enum ToolDefinitions {
    static let tools: [[String: Any]] = [
        [
            "name": "click",
            "description": "Click on a UI element by its [ID] from the accessibility tree, or at raw screen coordinates as fallback.",
            "input_schema": [
                "type": "object",
                "properties": [
                    "element_id": [
                        "type": "integer",
                        "description": "The [ID] number of the element from the accessibility tree (preferred)"
                    ],
                    "x": [
                        "type": "integer",
                        "description": "X coordinate on screen (fallback when no element_id)"
                    ],
                    "y": [
                        "type": "integer",
                        "description": "Y coordinate on screen (fallback when no element_id)"
                    ],
                    "reasoning": [
                        "type": "string",
                        "description": "Explanation of what you see and why you are clicking here"
                    ]
                ],
                "required": ["reasoning"]
            ] as [String: Any]
        ],
        [
            "name": "double_click",
            "description": "Double-click on a UI element by its [ID] from the accessibility tree, or at raw screen coordinates as fallback.",
            "input_schema": [
                "type": "object",
                "properties": [
                    "element_id": [
                        "type": "integer",
                        "description": "The [ID] number of the element from the accessibility tree (preferred)"
                    ],
                    "x": [
                        "type": "integer",
                        "description": "X coordinate on screen (fallback when no element_id)"
                    ],
                    "y": [
                        "type": "integer",
                        "description": "Y coordinate on screen (fallback when no element_id)"
                    ],
                    "reasoning": [
                        "type": "string",
                        "description": "Explanation of what you see and why you are double-clicking here"
                    ]
                ],
                "required": ["reasoning"]
            ] as [String: Any]
        ],
        [
            "name": "right_click",
            "description": "Right-click on a UI element by its [ID] from the accessibility tree, or at raw screen coordinates as fallback.",
            "input_schema": [
                "type": "object",
                "properties": [
                    "element_id": [
                        "type": "integer",
                        "description": "The [ID] number of the element from the accessibility tree (preferred)"
                    ],
                    "x": [
                        "type": "integer",
                        "description": "X coordinate on screen (fallback when no element_id)"
                    ],
                    "y": [
                        "type": "integer",
                        "description": "Y coordinate on screen (fallback when no element_id)"
                    ],
                    "reasoning": [
                        "type": "string",
                        "description": "Explanation of what you see and why you are right-clicking here"
                    ]
                ],
                "required": ["reasoning"]
            ] as [String: Any]
        ],
        [
            "name": "type_text",
            "description": "Type text at the current cursor position. The target field must already be focused (click it first).",
            "input_schema": [
                "type": "object",
                "properties": [
                    "text": [
                        "type": "string",
                        "description": "The text to type"
                    ],
                    "reasoning": [
                        "type": "string",
                        "description": "Explanation of what you are typing and why"
                    ]
                ],
                "required": ["text", "reasoning"]
            ] as [String: Any]
        ],
        [
            "name": "key",
            "description": "Press a key or keyboard shortcut. Supported: enter, tab, escape, backspace, delete, up, down, left, right, space, cmd+a, cmd+c, cmd+v, cmd+z, cmd+tab, cmd+w, shift+tab, option+tab",
            "input_schema": [
                "type": "object",
                "properties": [
                    "key": [
                        "type": "string",
                        "description": "Key or shortcut to press (e.g. enter, tab, cmd+c, cmd+v)"
                    ],
                    "reasoning": [
                        "type": "string",
                        "description": "Explanation of why you are pressing this key"
                    ]
                ],
                "required": ["key", "reasoning"]
            ] as [String: Any]
        ],
        [
            "name": "scroll",
            "description": "Scroll within an element by its [ID], or at raw screen coordinates as fallback.",
            "input_schema": [
                "type": "object",
                "properties": [
                    "element_id": [
                        "type": "integer",
                        "description": "The [ID] number of the element to scroll within (preferred)"
                    ],
                    "x": [
                        "type": "integer",
                        "description": "X coordinate on screen (fallback when no element_id)"
                    ],
                    "y": [
                        "type": "integer",
                        "description": "Y coordinate on screen (fallback when no element_id)"
                    ],
                    "direction": [
                        "type": "string",
                        "enum": ["up", "down", "left", "right"],
                        "description": "Scroll direction"
                    ],
                    "amount": [
                        "type": "integer",
                        "description": "Scroll amount (1-10)"
                    ],
                    "reasoning": [
                        "type": "string",
                        "description": "Explanation of why you are scrolling"
                    ]
                ],
                "required": ["direction", "amount", "reasoning"]
            ] as [String: Any]
        ],
        [
            "name": "wait",
            "description": "Wait for the UI to update",
            "input_schema": [
                "type": "object",
                "properties": [
                    "duration_ms": [
                        "type": "integer",
                        "description": "Milliseconds to wait"
                    ],
                    "reasoning": [
                        "type": "string",
                        "description": "Explanation of what you are waiting for"
                    ]
                ],
                "required": ["duration_ms", "reasoning"]
            ] as [String: Any]
        ],
        [
            "name": "done",
            "description": "Task is complete",
            "input_schema": [
                "type": "object",
                "properties": [
                    "summary": [
                        "type": "string",
                        "description": "Human-readable summary of what was accomplished"
                    ]
                ],
                "required": ["summary"]
            ] as [String: Any]
        ]
    ]
}
