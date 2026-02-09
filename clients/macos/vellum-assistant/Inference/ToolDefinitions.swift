import Foundation

enum ToolDefinitions {
    private static func makeClickVariant(name: String, verb: String) -> [String: Any] {
        [
            "name": name,
            "description": "\(verb) on a UI element by its [ID] from the accessibility tree, or at raw screen coordinates as fallback.",
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
                        "description": "Explanation of what you see and why you are \(verb.lowercased())ing here"
                    ]
                ],
                "required": ["reasoning"]
            ] as [String: Any]
        ]
    }

    static let tools: [[String: Any]] = [
        makeClickVariant(name: "click", verb: "Click"),
        makeClickVariant(name: "double_click", verb: "Double-click"),
        makeClickVariant(name: "right_click", verb: "Right-click"),
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
            "name": "drag",
            "description": "Drag from one element or position to another. Use for moving files, resizing windows, rearranging items, or adjusting sliders.",
            "input_schema": [
                "type": "object",
                "properties": [
                    "element_id": [
                        "type": "integer",
                        "description": "The [ID] of the source element to drag from (preferred)"
                    ],
                    "x": [
                        "type": "integer",
                        "description": "Source X coordinate (fallback when no element_id)"
                    ],
                    "y": [
                        "type": "integer",
                        "description": "Source Y coordinate (fallback when no element_id)"
                    ],
                    "to_element_id": [
                        "type": "integer",
                        "description": "The [ID] of the destination element to drag to (preferred)"
                    ],
                    "to_x": [
                        "type": "integer",
                        "description": "Destination X coordinate (fallback when no to_element_id)"
                    ],
                    "to_y": [
                        "type": "integer",
                        "description": "Destination Y coordinate (fallback when no to_element_id)"
                    ],
                    "reasoning": [
                        "type": "string",
                        "description": "Explanation of what you are dragging and why"
                    ]
                ],
                "required": ["reasoning"]
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
            "name": "open_app",
            "description": "Open or switch to a macOS application by name. Preferred over cmd+tab for switching apps — more reliable and explicit.",
            "input_schema": [
                "type": "object",
                "properties": [
                    "app_name": [
                        "type": "string",
                        "description": "The name of the application to open (e.g. \"Slack\", \"Safari\", \"Google Chrome\", \"VS Code\")"
                    ],
                    "reasoning": [
                        "type": "string",
                        "description": "Explanation of why you need to open or switch to this app"
                    ]
                ],
                "required": ["app_name", "reasoning"]
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
