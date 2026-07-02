# AI Virtual Laboratory

An AI-powered virtual laboratory that automatically generates 3D laboratory assets from natural language using LLMs and Tripo AI.

## Overview

The project allows users to create laboratory scenes simply by describing the equipment in natural language.

The AI system extracts entities, identifies laboratory objects, generates corresponding 3D models using Tripo AI, and places them into an interactive WebGL virtual laboratory.

---

## Features

- AI-powered laboratory generation
- Natural language input
- Named Entity Recognition (NER)
- Automatic translation
- Tripo AI integration
- Intelligent duplicate detection
- 3D asset caching
- FPS mode
- VR mode
- Physics alignment
- SaaS subscription
- Admin Dashboard

---

## AI Workflow

```
User Prompt
      │
      ▼
Translation
      │
      ▼
NER
      │
      ▼
Prompt Engineering
      │
      ▼
Tripo AI API
      │
      ▼
Generate 3D Model
      │
      ▼
Database Cache
      │
      ▼
Three.js Scene
```

---

## Core Technologies

### AI

- Hugging Face
- Transformers
- Prompt Engineering
- Named Entity Recognition

### Backend

- Python
- FastAPI
- PostgreSQL

### Frontend

- Three.js
- WebGL
- JavaScript

### Payment

- VNPay

---

## Key Contributions

- Multi-stage AI pipeline
- Intelligent asset caching
- Duplicate detection
- Event-driven physics correction
- Y_min mesh alignment
- SaaS monetization

---

## Performance

- Reduced duplicate generation
- Faster repeated asset loading
- Optimized API usage
- Lower generation cost

---

## Project Structure

```
backend/
frontend/
database/
static/
```

---

## Screenshots

(Add screenshots)

---

## Future Improvements

- Multi-agent workflow
- Better prompt optimization
- More accurate physics engine
- Automatic laboratory layout generation

---

## Author

Nguyễn Như Ý