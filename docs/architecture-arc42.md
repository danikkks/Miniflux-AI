# Introduction and Goals

Miniflux AI extensions allows to reduces the noise in an RSS feed by filtering out irrelevant articles and to have multiple perspectives on the same event by grouping similar articles from different sources. 

## Requirements Overview

1. Filtering of Miniflux feeds accordingly to the criterias described by a user in markdown format
2. Grouping


## Quality Goals

## Stakeholders

| Role/Name    | Contact         | Expectations        |
|--------------|-----------------|---------------------|
| *\<Role-1\>* | *\<Contact-1\>* | *\<Expectation-1\>* |
| *\<Role-2\>* | *\<Contact-2\>* | *\<Expectation-2\>* |

# Architecture Constraints

# Context and Scope

## Business Context

**\<Diagram or Table\>**

**\<optionally: Explanation of external domain interfaces\>**

## Technical Context

**\<Diagram or Table\>**

**\<optionally: Explanation of technical interfaces\>**

**\<Mapping Input/Output to Channels\>**

# Solution Strategy

# Building Block View

## Whitebox Overall System

***\<Overview Diagram\>***

Motivation  
*\<text explanation\>*

Contained Building Blocks  
*\<Description of contained building block (black boxes)\>*

Important Interfaces  
*\<Description of important interfaces\>*

### \<Name black box 1\>

*\<Purpose/Responsibility\>*

*\<Interface(s)\>*

*\<(Optional) Quality/Performance Characteristics\>*

*\<(Optional) Directory/File Location\>*

*\<(Optional) Fulfilled Requirements\>*

*\<(optional) Open Issues/Problems/Risks\>*

### \<Name black box 2\>

*\<black box template\>*

### \<Name black box n\>

*\<black box template\>*

### \<Name interface 1\>

…​

### \<Name interface m\>

## Level 2

### White Box *\<building block 1\>*

*\<white box template\>*

### White Box *\<building block 2\>*

*\<white box template\>*

…​

### White Box *\<building block m\>*

*\<white box template\>*

## Level 3

### White Box \<\_building block x.1\_\>

*\<white box template\>*

### White Box \<\_building block x.2\_\>

*\<white box template\>*

### White Box \<\_building block y.1\_\>

*\<white box template\>*

# Runtime View

Nothing runs on startup or on a schedule. Every processing run is started by the user from the review UI.

## Triggering a Processing Run

```mermaid
sequenceDiagram
    actor User
    participant UI as Review UI
    participant P as Processing
    participant S as Grouping / Filtering
    User->>UI: process now
    UI->>P: start run
    P->>S: join or start run
    UI-->>User: processing...
    loop periodically, while running
        User->>UI: ask status
        UI->>P: ask status
        P-->>UI: running
    end
    S-->>P: finished
    User->>UI: ask status
    UI->>P: ask status
    P-->>UI: completed / failed
    UI-->>User: result shown
```

- Grouping and filtering run in parallel by default, or one after another when configured, so the local AI keeps only one model loaded at a time.
- Pressing the button again during a run joins that run instead of starting another one.

## Filtering Entries

```mermaid
sequenceDiagram
    participant F as Entry Filter
    participant Pr as Prompts
    participant M as Miniflux
    participant C as AI Classifier
    participant D as Database
    F->>Pr: load prompts
    F->>M: get categories and feeds that have a prompt
    loop until no new entries
        F->>M: get unread entries
        loop per entry
            F->>C: is it relevant?
            C-->>F: yes / no
            F->>D: save decision
            opt irrelevant
                F->>M: mark as read
            end
        end
    end
```

- Each category is matched to the user's prompt written for it.
- Entries are fetched repeatedly, because Miniflux returns only a limited number at a time.
- If the classifier fails or gives an unclear answer, the entry stays unread and is retried on the next run.
- An unsure answer (probability of relevance between 0.3 and 0.5) leaves the entry unread, so only a confident "no" hides an entry.
- A decision that changes on a later run goes back to the review queue.

## Grouping Stories and Publishing the Feed

```mermaid
sequenceDiagram
    participant G as Story Grouper
    participant M as Miniflux
    participant C as AI Classifier
    participant D as Database
    participant Su as AI Summarizer
    participant FS as Feed Storage
    G->>M: get grouping categories and feeds
    G->>D: get open groups
    loop until no new entries
        G->>M: get unread entries
        loop per entry
            G->>C: is it a digest?
            alt digest
                C-->>G: yes, skip entry
            else single story
                G->>C: is it a news event?
                opt not news
                    C-->>G: no
                    G->>M: mark as read, skip entry
                end
                loop per open group, until a match
                    G->>C: same story?
                end
                G->>D: add entry to matching or new group
                G->>M: mark as read
            end
        end
    end
    loop per changed group
        G->>Su: write title and description
        G->>D: save summary
    end
    opt feed changed
        G->>FS: publish feed
        G->>M: refresh the published feed
    end
```

- A group stays open for new entries, and stays in the feed, only for a limited time after its first entry.
- Summaries are written after all grouping decisions, so the two AI models are not needed at the same time.
- Miniflux subscribes to the published feed like any other feed, so grouped stories are filtered like regular entries.
- A failing entry is retried on the next run. If Miniflux becomes unavailable mid-run, the groups made so far are still summarized and published, and the run is reported as failed.

## Reviewing Decisions and Improving a Prompt

```mermaid
sequenceDiagram
    actor User
    participant UI as Review UI
    participant R as Review Service
    participant D as Database
    participant Pr as Prompts
    User->>UI: open UI
    UI->>R: list pending
    R->>D: get unreviewed decisions
    User->>UI: mark correct / wrong
    UI->>R: submit review
    R->>D: save verdicts
    R->>Pr: get current prompt
    R->>D: get recent verdicts
    UI-->>User: improvement request per category
    User->>UI: copy it
    UI->>R: mark reviewed
    R->>D: mark reviewed
    Note over User: ask a stronger AI model, then update the prompt manually
```

- Subcategories are reviewed together with their parent category, so one request improves one prompt.
- The user can discard older unreviewed decisions to keep the queue short. Discarded decisions are not used to improve prompts.
- The next run uses the updated prompt.

# Deployment View

## Infrastructure Level 1

***\<Overview Diagram\>***

Motivation  
*\<explanation in text form\>*

Quality and/or Performance Features  
*\<explanation in text form\>*

Mapping of Building Blocks to Infrastructure  
*\<description of the mapping\>*

## Infrastructure Level 2

### *\<Infrastructure Element 1\>*

*\<diagram + explanation\>*

### *\<Infrastructure Element 2\>*

*\<diagram + explanation\>*

…​

### *\<Infrastructure Element n\>*

*\<diagram + explanation\>*

# Cross-cutting Concepts

## *\<Concept 1\>*

*\<explanation\>*

## *\<Concept 2\>*

*\<explanation\>*

…​

## *\<Concept n\>*

*\<explanation\>*

# Architecture Decisions

# Quality Requirements

## Quality Requirements Overview

## Quality Scenarios

# Risks and Technical Debts

# Glossary

| Term         | Definition         |
|--------------|--------------------|
| *\<Term-1\>* | *\<definition-1\>* |
| *\<Term-2\>* | *\<definition-2\>* |

