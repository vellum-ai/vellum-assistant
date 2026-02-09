---
title: "Text-to-UI"
slug: "convert-restaurant-menus-into-online-ready-ordering"
seoTitle: "Render Raw Restaurant Menu Text into UI components"
description: "Extract and categorize raw menu text, and use LLMs to render the UI for applications like POS software."
shortDescription: "Extract and categorize menu text, and use it in applications like POS software."
publicWorkflowTag: "62f0fefc-6a72-4900-b0a5-8410dbf6b82a"
industry: "Hospitality"
coverImage: "https://cdn.sanity.io/images/ghjnhoi4/production/1e4efe5e15b7e1826c266db661865af0966a55f5-1344x896.png"
---

## Workflow Nodes

### Step Raw menu text: Raw menu input (Input)

Grilled Chicken Alfredo Options: Gluten-free noodles +$2, Extra parmesan +$1, Swap for shrimp +$3, Tofu +$2, Spicy +$0.50 Margherita Pizza Options: Cauliflower crust +$3, Extra cheese +$2, Vegan cheese +$2, Gluten-free crust +$2 Beef Tacos Options: Corn or flour tortillas, Swap for chicken +$1, Jackfruit +$2, Guac +$1.50, Sour cream +$1, Jalapeños +$0.50 Caesar Salad Options: Add chicken +$3, Shrimp +$4, Tofu +$2, Dairy-free dressing +$1, Gluten-free croutons +$1, Extra anchovies +$2 Spaghetti Bolognese Options: Whole wheat or gluten-free pasta +$2, Turkey +$2, Plant-based +$3, Extra sauce +$1, Spicy +$0.50 Vegetarian Burrito Options: Vegan (omit cheese/sour cream), Guac +$1.50, White or brown rice, Spicy salsa +$0.50 Cheeseburger Options: Beef, chicken, or veggie patty, Gluten-free bun +$2, Bacon +$2, Avocado +$2, No cheese (dairy-free) -$1 Tom Yum Soup Options: Shrimp +$3, Chicken +$2, Tofu +$2, Spicy broth +$1, Extra mushrooms +$1, Cilantro +$0.50, Gluten-free +$1 Pad Thai Options: Chicken, shrimp +$2, Tofu +$2, Gluten-free noodles +$2, Extra peanuts +$1, Lime +$0.50, Vegan +$1 Greek Salad Options: Add chicken +$3, Shrimp +$4, Tofu +$2, No feta (vegan), Extra olives +$1, Cucumbers +$1, Lemon vinaigrette or traditional

‍

### Step 1: Convert to JSON

Convert raw menu text into structured JSON format for easier processing, integration, and use in applications.

### Step 2: Convert to HTML

Use LLMs to convert the JSON into clean, beautiful HTML that’s ready to bring your UI to life.

### Step 3: Encodes in Base64 and appends to a URL

Use Base64 encoding to convert the data into a safe, text-based format for embedding in URLs, allowing it to be decoded and used, like rendering HTML or images, directly from the link.

### UI for Menu (Output)

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/f128b3a8c0ba3c14355839761110e6c9ca232c86-1266x974.png)

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/2ce80b015d77a3268787e98941d2540af254fec7-1266x600.png)

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/14a692838adbc76e6b37e3eaf0c6dd213f6c847c-1270x604.png)

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/ab701d56dc991cf83ca43b770a91c6b1e90269cf-1254x592.png)

## Tools

- Data Extraction
- Integration
- UI render
- Parser

## AI Tasks

- **Data transformation**

## Customizations

1/ Parse PDFs or image files

2/ Invoke APIs, add the outputs to your database

3/ Use execution history to create test suites for quantitative evaluation

4/ Flag for human review under certain conditions

5/ Compare different models to optimize cost and speed
